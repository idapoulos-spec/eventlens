// Runs one scan in the browser: the stock's prices once, each candidate's Kalshi side a few at a
// time, and each candidate's test in slices on the main thread (at most about 30 ms of work per
// task, as panelJobs.ts does for the Research panel), so the page stays responsive and results
// appear as they finish. When every candidate is in, leave-one-out runs for the top results.

import type { Resolution } from "@/lib/analytics/research";
import type { LeaveOneOut } from "@/lib/analytics/fragility";
import { correctScan, leaveOneOutTargets, rankScan, scanCandidateSteps, scanLeaveOneOutSteps, type Correction, type ScanInput, type ScanTest } from "@/lib/analytics/scan";
import type { WindowChoice } from "@/lib/history/window";
import type { BenchmarkSeries } from "@/lib/market-data/types";
import { RETRY_STATUSES, SCAN_ASOF_PARAM, spanParams } from "@/lib/scan/api";
import { scanStock, type ScanStock } from "@/lib/scan/bars";
import { candidateInput } from "@/lib/scan/rows";
import { priceSpan } from "@/lib/scan/span";
import { SCAN_CANDIDATE_PATH, SCAN_PRICES_PATH, type ScanCandidate, type ScanErrorResponse, type ScanKalshi, type ScanPrices } from "@/lib/scan/types";

/** Candidates loading at once: a few Kalshi requests a second, well under its 20 reads a second. */
const LOAD_CONCURRENCY = 3;
/** Pauses before trying a busy upstream again (ms). */
const RETRY_DELAYS_MS = [2_000, 5_000];
const SLICE_MS = 30;
/** Inputs kept for leave-one-out: it runs only for candidates ranked this high or better. */
const KEEP_INPUTS = 10;

export interface ScanSettings {
  stock: string;
  choice: WindowChoice;
  resolution: Resolution;
  candidates: ScanCandidate[];
  /** A frozen scan's as-of time (ms): windows still open then end there. */
  asOf?: number | null;
}

export type CandidateState =
  | { status: "queued" | "loading" | "computing" }
  | { status: "untested"; reason: string }
  | { status: "done"; test: ScanTest; asOf: number; sameAs90: boolean; loo: LeaveOneOut | null | "pending" | "skipped" };

export interface ScanTimings {
  /** ms from the start: when the prices came in, the first result, and the last. */
  prices: number | null;
  firstResult: number | null;
  finished: number | null;
  /** When leave-one-out finished for every target. */
  leaveOneOut: number | null;
  /** The longest the page went without the main thread (ms). */
  longestSlice: number;
  /** Kalshi loads, ms each. */
  loads: number[];
  /** Compute per candidate, ms (first stage and refinement). */
  computes: number[];
}

export interface ScanSnapshot {
  phase: "prices" | "running" | "leave_one_out" | "done" | "failed";
  error: string | null;
  states: CandidateState[];
  /** Holm and BH for each candidate, with pending ones counted as p = 1 (final once done). */
  corrections: (Correction | null)[];
  /** Candidate indices, best first (tested ones; untested and pending after). */
  order: number[];
  prices: Pick<ScanPrices, "requests" | "fetchedAt"> | null;
  /** Waiting for Twelve Data's next minute until this time (ms since 1970), or null. */
  waitingUntil: number | null;
  timings: ScanTimings;
}

const now = () => performance.now();

function mark(name: string, start: number, duration: number) {
  try {
    performance.measure(`scan:${name}`, { start, duration });
  } catch {
    // Older browsers: no timing marks.
  }
}

type Fetched<T> = { ok: true; data: T } | { ok: false; status: number; message: string };

/** How a request is retried: Kalshi's loads quickly (it limits by the second); the prices only once Twelve Data's minute is over. */
interface RetryPolicy {
  /** Pauses before the next attempt after a busy or failed upstream (429, 503, 504, or no answer). */
  quick: number[];
  /** Otherwise wait out a 429's Retry-After of up to this many seconds, at most `waits` times. */
  waitUpToSec: number;
  waits: number;
  onWait?: (until: number) => void;
}

const KALSHI_RETRIES: RetryPolicy = { quick: RETRY_DELAYS_MS, waitUpToSec: 0, waits: 0 };

async function getJson<T>(url: string, signal: AbortSignal, policy: RetryPolicy = KALSHI_RETRIES): Promise<Fetched<T>> {
  let quick = 0;
  let waits = 0;
  for (;;) {
    let response: Response;
    try {
      response = await fetch(url, { signal });
    } catch (err) {
      if (signal.aborted) throw err;
      if (quick < policy.quick.length) {
        await new Promise((r) => setTimeout(r, policy.quick[quick++]));
        continue;
      }
      return { ok: false, status: 0, message: "The server couldn't be reached." };
    }
    if (response.ok) return { ok: true, data: (await response.json()) as T };
    const retryAfter = Number(response.headers.get("Retry-After"));
    if (response.status === 429 && waits < policy.waits && retryAfter > 0 && retryAfter <= policy.waitUpToSec) {
      waits++;
      policy.onWait?.(Date.now() + retryAfter * 1000);
      await new Promise((r) => setTimeout(r, retryAfter * 1000));
      policy.onWait?.(0);
      continue;
    }
    if (RETRY_STATUSES.has(response.status) && quick < policy.quick.length) {
      await new Promise((r) => setTimeout(r, policy.quick[quick++]));
      continue;
    }
    const body = (await response.json().catch(() => null)) as ScanErrorResponse | null;
    return { ok: false, status: response.status, message: body?.error.message ?? `The request failed (${response.status}).` };
  }
}

export class ScanRun {
  private abort = new AbortController();
  private started = now();
  private stock: ScanStock | null = null;
  private benchmark: BenchmarkSeries | null = null;
  private kalshi = new Map<number, ScanKalshi>();
  private inputs = new Map<number, ScanInput>();
  private queue: { id: number; kind: "test" | "loo"; steps: Generator<void, unknown>; spent: number }[] = [];
  private scheduled = false;
  private channel: MessageChannel | null = null;
  private listeners = new Set<() => void>();
  private snapshot: ScanSnapshot;
  private states: CandidateState[];
  private loading = 0;
  private nextLoad = 0;

  constructor(private settings: ScanSettings) {
    this.states = settings.candidates.map(() => ({ status: "queued" }));
    this.snapshot = this.build("prices", null, null);
    void this.start();
  }

  private timings: ScanTimings = { prices: null, firstResult: null, finished: null, leaveOneOut: null, longestSlice: 0, loads: [], computes: [] };
  private pricesInfo: ScanSnapshot["prices"] = null;
  private waitingUntil: number | null = null;

  private async start() {
    const { stock, choice, candidates, asOf = null } = this.settings;
    const span = priceSpan(candidates, choice, Date.now(), asOf);
    if (!span) return this.fail("There are no candidates to scan.");
    // Kalshi loads start with the prices; computing waits for both.
    this.pump();
    const t0 = now();
    // Twelve Data's free plan allows 8 requests a minute for everyone using the key; when they're
    // used up, wait for the next minute (twice at most) rather than spend more on retries.
    const frozen = asOf === null ? "" : `&${new URLSearchParams({ [SCAN_ASOF_PARAM]: String(asOf) })}`;
    const prices = await getJson<ScanPrices>(`${SCAN_PRICES_PATH}?${new URLSearchParams({ stock })}&${spanParams(span)}${frozen}`, this.abort.signal, {
      quick: [],
      waitUpToSec: 70,
      waits: 2,
      onWait: (until) => {
        this.waitingUntil = until || null;
        this.publish();
      },
    }).catch(() => null);
    if (prices === null) return;
    if (!prices.ok) return this.fail(prices.message);
    mark("prices", t0, now() - t0);
    this.timings.prices = now() - this.started;
    this.stock = scanStock(prices.data);
    this.benchmark = prices.data.benchmark;
    this.pricesInfo = { requests: prices.data.requests, fetchedAt: prices.data.fetchedAt };
    for (const id of this.kalshi.keys()) this.enqueueTest(id);
    this.publish();
  }

  private fail(message: string) {
    this.abort.abort();
    this.queue = [];
    this.publish("failed", message);
  }

  /** Starts Kalshi loads until LOAD_CONCURRENCY are in flight. */
  private pump() {
    const { candidates, choice, asOf = null } = this.settings;
    while (this.loading < LOAD_CONCURRENCY && this.nextLoad < candidates.length) {
      const id = this.nextLoad++;
      const c = candidates[id];
      this.loading++;
      this.states[id] = { status: "loading" };
      const t0 = now();
      const params = new URLSearchParams({ ticker: c.ticker, kind: c.kind, long: choice === "all" || choice > 90 ? "1" : "0", ...(asOf !== null && { [SCAN_ASOF_PARAM]: String(asOf) }) });
      getJson<ScanKalshi>(`${SCAN_CANDIDATE_PATH}?${params}`, this.abort.signal)
        .then((r) => {
          const ms = now() - t0;
          mark("load", t0, ms);
          this.timings.loads.push(ms);
          if (!r.ok) {
            this.states[id] = { status: "untested", reason: r.message };
          } else {
            this.kalshi.set(id, r.data);
            this.states[id] = { status: "computing" };
            if (this.stock) this.enqueueTest(id);
          }
        })
        .catch(() => undefined)
        .finally(() => {
          this.loading--;
          if (!this.abort.signal.aborted) {
            this.pump();
            this.publish();
            this.checkAllIn();
          }
        });
    }
  }

  /** Queues a candidate's rows and test as steps, so building rows for many candidates at once never blocks the page. */
  private enqueueTest(id: number) {
    const kalshi = this.kalshi.get(id)!;
    this.kalshi.delete(id);
    const { choice, resolution } = this.settings;
    const steps = (function* (run: ScanRun) {
      const built = candidateInput(run.stock!, run.benchmark!, kalshi, choice, resolution);
      if (!built.ok) {
        run.states[id] = { status: "untested", reason: built.error.message };
        run.publish();
        return run.checkAllIn();
      }
      run.inputs.set(id, built.data.input);
      yield;
      const test = yield* scanCandidateSteps(built.data.input);
      run.finishTest(id, test, built.data.asOf, built.data.sameAs90);
    })(this);
    this.queue.push({ id, kind: "test", steps, spent: 0 });
    this.schedule();
  }

  private finishTest(id: number, test: ScanTest, asOf: number, sameAs90: boolean) {
    this.states[id] =
      test.p === null
        ? { status: "untested", reason: untestedReason(test) }
        : { status: "done", test, asOf, sameAs90, loo: null };
    if (test.p === null) this.inputs.delete(id);
    if (this.timings.firstResult === null && test.p !== null) this.timings.firstResult = now() - this.started;
    this.publish();
    // Keep inputs only for candidates that could still need leave-one-out.
    const ranked = new Set(this.snapshot.order.slice(0, KEEP_INPUTS));
    for (const key of [...this.inputs.keys()]) if (!ranked.has(key) && this.states[key].status === "done") this.inputs.delete(key);
    this.checkAllIn();
  }

  /** Once every candidate has a result or a reason it has none, the corrections are final: leave-one-out starts. */
  private checkAllIn() {
    if (this.timings.finished !== null || !this.states.every((s) => s.status === "done" || s.status === "untested")) return;
    this.startLeaveOneOut();
  }

  private startLeaveOneOut() {
    this.timings.finished = now() - this.started;
    const { order, corrections } = this.snapshot;
    const tested = (i: number) => this.states[i].status === "done";
    const survives = (i: number) => !!(corrections[i]?.survivesHolm || corrections[i]?.survivesBh);
    const targets = leaveOneOutTargets(order, tested, survives);
    for (const id of targets) {
      const state = this.states[id];
      const input = this.inputs.get(id);
      if (state.status !== "done" || !input) continue;
      state.loo = "pending";
      const steps = (function* (run: ScanRun) {
        const loo = yield* scanLeaveOneOutSteps(input, state.test);
        run.finishLeaveOneOut(id, loo);
      })(this);
      this.queue.push({ id, kind: "loo", steps, spent: 0 });
    }
    this.inputs.clear();
    // The candidate that just finished may still be in the queue (its last step called this).
    if (!this.queue.some((q) => q.kind === "loo")) {
      this.timings.leaveOneOut = this.timings.finished;
      this.publish("done");
    } else {
      this.publish("leave_one_out");
      this.schedule();
    }
  }

  private finishLeaveOneOut(id: number, loo: LeaveOneOut | null) {
    const state = this.states[id];
    if (state.status === "done") this.states[id] = { ...state, loo: loo ?? "skipped" };
    const left = this.queue.filter((q) => q.kind === "loo" && q.id !== id).length;
    if (left === 0) {
      this.timings.leaveOneOut = now() - this.started;
      this.publish("done");
    } else this.publish();
  }

  private schedule() {
    if (this.scheduled || this.queue.length === 0) return;
    this.scheduled = true;
    // A message, not setTimeout, so the slices aren't spaced out by timer clamping.
    if (!this.channel && typeof MessageChannel !== "undefined") {
      this.channel = new MessageChannel();
      this.channel.port1.onmessage = () => this.slice();
    }
    if (this.channel) this.channel.port2.postMessage(null);
    else setTimeout(() => this.slice(), 0);
  }

  private slice() {
    this.scheduled = false;
    const start = now();
    while (this.queue.length > 0 && now() - start < SLICE_MS) {
      const job = this.queue[0];
      const t0 = now();
      const step = job.steps.next();
      job.spent += now() - t0;
      if (step.done) {
        this.queue.shift();
        if (job.kind === "test") {
          this.timings.computes.push(job.spent);
          mark("compute", start, job.spent);
        } else mark("leave_one_out", start, job.spent);
      }
    }
    const ms = now() - start;
    this.timings.longestSlice = Math.max(this.timings.longestSlice, ms);
    mark("slice", start, ms);
    this.schedule();
  }

  private build(phase: ScanSnapshot["phase"], error: string | null, prices: ScanSnapshot["prices"]): ScanSnapshot {
    const states = [...this.states];
    const ps = states.map((s) => (s.status === "done" ? s.test.p : null));
    const finished = states.map((s) => s.status === "done" || s.status === "untested");
    const pending = finished.filter((f) => !f).length;
    // Corrections over the finished candidates, the pending ones counted as p = 1.
    const corrected = correctScan(ps.filter((_, i) => finished[i]), pending);
    let k = 0;
    const corrections = states.map((_, i) => (finished[i] ? corrected[k++] : null));
    const order = rankScan(
      states.map((s, i) => ({
        p: s.status === "done" ? s.test.p : null,
        firstP: s.status === "done" ? (s.test.primary?.p ?? null) : null,
        key: this.settings.candidates[i].ticker,
      })),
    );
    return { phase, error, states, corrections, order, prices, waitingUntil: this.waitingUntil ?? null, timings: { ...this.timings, loads: [...this.timings.loads], computes: [...this.timings.computes] } };
  }

  private publish(phase: ScanSnapshot["phase"] = this.snapshot.phase === "prices" && this.stock ? "running" : this.snapshot.phase, error: string | null = this.snapshot.error) {
    this.snapshot = this.build(phase, error, this.pricesInfo);
    for (const listener of this.listeners) listener();
  }

  dispose() {
    this.abort.abort();
    this.queue = [];
    this.channel?.port1.close();
    this.channel = null;
    this.listeners.clear();
  }

  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getSnapshot = () => this.snapshot;
}

/** Why a loaded candidate has no p-value, in the page's words. */
export function untestedReason(test: ScanTest): string {
  if (!test.primary) return "No market model: the benchmark has too few prices in its window.";
  switch (test.primary.pUnavailable) {
    case "too_few_pairs":
      return "Too few intervals with both prices in its window.";
    case "too_few_blocks":
      return "Fewer than 8 sessions in its window, so no p-value (as on its page).";
    case "no_variation":
      return "Its Kalshi value didn't move in the window.";
    default:
      return "The test is unstable on its data (as on its page).";
  }
}
