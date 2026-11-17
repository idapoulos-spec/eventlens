import {
  panelCoreSteps,
  panelEvents,
  panelResults,
  secondaryDetectable,
  secondaryLeaveOneOutSteps,
  signalCheckInput,
  type PanelCore,
  type PanelInput,
  type PanelResults,
} from "./panel";
import type { DetectableCorrelation } from "./correlation-test";
import type { LeaveOneOut } from "./fragility";
import { leadOf, signalCheckSteps, type LeadCheckInput, type SignalCheck } from "./signal";

// The Research panel's computations as jobs, run in slices on the page after its main results
// (components/research/panelJobs.ts). Pure apart from timing, so it's tested directly.

/**
 * main: every result the cards show, for the longer windows (too slow for the page itself).
 * secondary: the detectable size and the leave-one-out check, for every window.
 * signal: the experimental signal's check of its Kalshi-first lead, from the page's own results (no core).
 * `coreKey` names everything but the jump size, so a job for another jump size reuses the core.
 */
export type PanelJob =
  | { kind: "main"; key: string; coreKey: string; input: PanelInput; threshold: number }
  | { kind: "secondary"; key: string; coreKey: string; input: PanelInput }
  | { kind: "signal"; key: string; check: LeadCheckInput };

/** A job's results, each part as soon as it's ready, with how long it took (ms). */
export type PanelMessage =
  | { kind: "main"; key: string; value: PanelResults; ms: number }
  | { kind: "detectable"; key: string; value: DetectableCorrelation | null; ms: number }
  | { kind: "leave_one_out"; key: string; value: LeaveOneOut | null; ms: number }
  | { kind: "signal_check"; key: string; value: SignalCheck | null; ms: number };

const now = () => (typeof performance === "undefined" ? Date.now() : performance.now());

/**
 * Runs a job as steps (each a few tens of milliseconds at the longest windows), yielding a message
 * whenever a part is ready, and keeps the last core (with or without its lead-lag tests) for the
 * next job. `ms` is the computing time a part took, not counting the pauses between steps.
 */
export function panelRunner() {
  let cached: { coreKey: string; core: PanelCore; lags: boolean } | null = null;

  return function* run(job: PanelJob): Generator<PanelMessage | null, void> {
    // Computing time since the last message, not counting the pauses at each `yield`.
    let busy = 0;
    let since = now();
    const elapsed = () => {
      const ms = busy + (now() - since);
      busy = 0;
      since = now();
      return ms;
    };
    function* steps<T>(gen: Generator<void, T>): Generator<null, T> {
      for (;;) {
        const r = gen.next();
        if (r.done) return r.value;
        busy += now() - since;
        yield null;
        since = now();
      }
    }
    function* coreFor(coreKey: string, input: PanelInput, lags: boolean): Generator<null, PanelCore> {
      if (!cached || cached.coreKey !== coreKey || (lags && !cached.lags)) {
        cached = { coreKey, core: yield* steps(panelCoreSteps(input, { lags })), lags };
      }
      return cached.core;
    }

    if (job.kind === "signal") {
      const value = yield* steps(signalCheckSteps(job.check));
      yield { kind: "signal_check", key: job.key, value, ms: elapsed() };
      return;
    }
    if (job.kind === "main") {
      const core = yield* coreFor(job.coreKey, job.input, true);
      const value = panelResults(core, panelEvents(job.input, core, job.threshold));
      yield { kind: "main", key: job.key, value, ms: elapsed() };
      return;
    }
    const core = yield* coreFor(job.coreKey, job.input, false);
    const detectable = secondaryDetectable(core, job.input.resolution);
    yield { kind: "detectable", key: job.key, value: detectable, ms: elapsed() };
    since = now();
    const leaveOneOut = yield* steps(secondaryLeaveOneOutSteps(job.input, core));
    yield { kind: "leave_one_out", key: job.key, value: leaveOneOut, ms: elapsed() };
  };
}

/** Runs a job's steps to the end, posting each message: for tests, and anywhere slicing doesn't matter. */
export function runJob(run: ReturnType<typeof panelRunner>, job: PanelJob, post: (message: PanelMessage) => void): void {
  for (const m of run(job)) if (m) post(m);
}

/**
 * The signal's check for these results, when its rules reach it: market-adjusted lags with a
 * Kalshi-first lead that passes alone (S1–S4 don't decide). Keyed by `key` (the window, resolution,
 * and benchmark) and the lead's lag. Null when no check is needed, or when it can't be set up.
 */
export function signalJob(key: string, input: PanelInput, results: PanelResults): Extract<PanelJob, { kind: "signal" }> | null {
  if (results.shown !== "adjusted") return null;
  const { kalshiFirst, first } = leadOf(results.view.lags);
  if (!kalshiFirst || first === "both") return null;
  const check = signalCheckInput(input, results, kalshiFirst.lag, kalshiFirst.test);
  return check && { kind: "signal", key: `${key}|signal:${kalshiFirst.lag}`, check };
}

/** Whether the signal needs a check for these results (a lead passes alone), whatever the job's setup. */
export function signalNeedsCheck(results: PanelResults): boolean {
  if (results.shown !== "adjusted") return false;
  const { kalshiFirst, first } = leadOf(results.view.lags);
  return Boolean(kalshiFirst) && first !== "both";
}
