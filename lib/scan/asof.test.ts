// A frozen scan's result for a candidate is its frozen page's: with an as-of time, through the
// loaders and the runner, against the fake world (its scenarios are read, never changed), each
// candidate's primary test and fragility diagnostics are what its page gives from a link frozen
// at the same time, whether the candidate was still open then or had closed.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { panelCore, type PanelInput } from "@/lib/analytics/panel";
import { rowsSince, type Resolution } from "@/lib/analytics/research";
import { scanFirstStage, type ScanTest } from "@/lib/analytics/scan";
import { eventLongRows, eventResearchRows, lastRows, marketLongRows, marketResearchRows, type LongRows, type ResearchRows } from "@/lib/history/rows";
import { HOUR_MS, stubWorld, worldEvent, worldMarket } from "@/lib/history/test-world";
import { STOCK_HISTORY_MS, windowPlan, type WindowChoice } from "@/lib/history/window";
import { benchmarkFrom } from "@/lib/market-data/benchmark-series";
import type { BenchmarkSeries } from "@/lib/market-data/types";
import { ok, type Result } from "@/lib/result";
import type { loadEventAnalysis as LoadEventAnalysis } from "@/lib/expected/load";
import type { loadAnalysis as LoadAnalysis } from "@/lib/history/analysis";
import type { ScanRun as ScanRunClass, ScanSnapshot } from "@/components/scan/scanRunner";
import { parseScanAsOf, parseSpan } from "./api";
import { scanStock } from "./bars";
import type { tickerCandidates as TickerCandidates } from "./candidates";
import type { loadCandidateKalshi as LoadCandidateKalshi } from "./load";
import type { getScanPrices as GetScanPrices } from "./prices";
import { candidateInput } from "./rows";
import { priceSpan } from "./span";
import { SCAN_CANDIDATE_PATH, SCAN_PRICES_PATH } from "./types";

vi.setConfig({ testTimeout: 120_000 });
vi.mock("server-only", () => ({}));
vi.mock("@/lib/store/db", () => ({ getAppSql: () => null }));

// Viewed on Oct 25, 2026, frozen at Monday, Oct 5, 2:02 PM New York.
const NOW = Date.UTC(2026, 9, 25, 16);
const AS_OF = Date.UTC(2026, 9, 5, 18, 2, 10);
const LIVE_MARKET = worldMarket("KXFEDDECISION-26DEC-H0", { status: "active", open: Date.UTC(2025, 4, 1), close: Date.UTC(2026, 11, 9, 19), archived: false });
// Closed before the as-of time (still on the live endpoints): its windows end at its close, store or not.
const CLOSED_MARKET = worldMarket("KXFEDDECISION-26SEP-H0", { status: "finalized", open: Date.UTC(2025, 2, 20, 14), close: Date.UTC(2026, 8, 16, 18), archived: false });
const LONG_EVENT = worldEvent("KXFEDDECISION-26DEC", { status: "active", open: Date.UTC(2025, 5, 2, 14), close: Date.UTC(2026, 11, 9, 19), archived: false }, { bounded: true });

const CHOICES: [WindowChoice, Resolution][] = [
  [7, "hourly"],
  [30, "daily"],
  [90, "hourly"],
  [90, "daily"],
  [180, "hourly"],
  ["all", "daily"],
];

let loadAnalysis: typeof LoadAnalysis;
let loadEventAnalysis: typeof LoadEventAnalysis;
let tickerCandidates: typeof TickerCandidates;
let loadCandidateKalshi: typeof LoadCandidateKalshi;
let getScanPrices: typeof GetScanPrices;
let ScanRun: typeof ScanRunClass;

beforeEach(async () => {
  vi.stubEnv("TWELVE_DATA_API_KEY", "test-key");
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  vi.resetModules();
  ({ loadAnalysis } = await import("@/lib/history/analysis"));
  ({ loadEventAnalysis } = await import("@/lib/expected/load"));
  ({ tickerCandidates } = await import("./candidates"));
  ({ loadCandidateKalshi } = await import("./load"));
  ({ getScanPrices } = await import("./prices"));
  ({ ScanRun } = await import("@/components/scan/scanRunner"));
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

/** The page's panel input for a window, as ResearchPanel builds it (as in parity.test.ts). */
function pageInput(rows: ResearchRows, long: LongRows | null, benchmark: BenchmarkSeries, longStart: number, scale: number, choice: WindowChoice, resolution: Resolution): PanelInput {
  const { hourly, daily, asOf } = lastRows(rows);
  const bench = benchmarkFrom(benchmark, Math.min(longStart, asOf - STOCK_HISTORY_MS));
  const closes = resolution === "hourly" ? bench.hourly : bench.daily;
  const plan = windowPlan(choice, ok(long), asOf);
  if (plan.kind === "long") return { full: rowsSince(resolution === "hourly" ? plan.rows.hourly : plan.rows.daily, plan.from), from: -Infinity, resolution, scale, closes, returns: "adjusted" };
  if (plan.kind !== "loaded") throw new Error("expected a window");
  return { full: resolution === "hourly" ? hourly : daily, from: asOf - plan.days * 24 * HOUR_MS, resolution, scale, closes, returns: "adjusted" };
}

const benchmarkOf = (b: Result<BenchmarkSeries> | null) => {
  if (!b?.ok) throw new Error("expected a benchmark");
  return b.data;
};

type Page = (c: WindowChoice, r: Resolution) => ReturnType<typeof panelCore>;

/** A market's frozen page: its primary test and fragility at each window. */
async function marketPage(stock: string, ticker: string): Promise<Page> {
  const { kalshiData, stockData, researchHistory, benchmarkData, longHistory } = loadAnalysis(stock, ticker, { asOf: AS_OF });
  const [k, s, h, b, l] = await Promise.all([kalshiData, stockData, researchHistory, benchmarkData, longHistory]);
  if (!k.ok || !s.ok || !h.ok || !l.ok) throw new Error("expected an analysis");
  const closeTime = Date.parse(k.data.market.closeTime!);
  const side = { research: s.data.research, fetchedAt: s.data.historyFetchedAt };
  const rows = marketResearchRows({ kalshi: h.data.points, closeTime, ...side });
  const long = l.data && marketLongRows({ history: l.data, closeTime, ...side });
  return (choice, resolution) => panelCore(pageInput(rows, long, benchmarkOf(b), s.data.research.longStart, 100, choice, resolution), { lags: false });
}

async function eventPage(stock: string, ticker: string): Promise<Page> {
  const { event, stockData, benchmarkData, long: longMarks } = loadEventAnalysis(stock, ticker, { asOf: AS_OF });
  const [e, s, b, l] = await Promise.all([event, stockData, benchmarkData, longMarks]);
  if (!e.ok || !s.ok || !l.ok) throw new Error("expected an analysis");
  const side = { research: s.data.research, fetchedAt: s.data.historyFetchedAt };
  const rows = eventResearchRows({ marks: e.data.marks, ...side });
  const long = l.data && eventLongRows({ marks: l.data.marks, start: l.data.start, ...side });
  return (choice, resolution) => panelCore(pageInput(rows, long, benchmarkOf(b), s.data.research.longStart, 1, choice, resolution), { lags: false });
}

/** The frozen scan's result for one candidate, through its routes' loaders. */
async function scanned(stock: string, ticker: string) {
  const list = await tickerCandidates([ticker], Date.now(), AS_OF);
  if (!list.ok || list.data.candidates.length !== 1) throw new Error("expected one candidate");
  const [candidate] = list.data.candidates;
  return async (choice: WindowChoice, resolution: Resolution) => {
    const span = priceSpan([candidate], choice, Date.now(), AS_OF)!;
    expect(span.live).toBe(false);
    const prices = await getScanPrices(stock, span, AS_OF);
    const kalshi = await loadCandidateKalshi(candidate.ticker, candidate.kind, choice === "all" || choice > 90, AS_OF);
    if (!prices.ok || !kalshi.ok) throw new Error("expected prices and a candidate");
    const input = candidateInput(scanStock(prices.data), prices.data.benchmark, kalshi.data, choice, resolution);
    if (!input.ok) throw new Error(input.error.message);
    return { asOf: input.data.asOf, result: scanFirstStage(input.data.input) };
  };
}

async function expectSame(page: Page, scan: Awaited<ReturnType<typeof scanned>>, end: number) {
  let tested = 0;
  for (const [choice, resolution] of CHOICES) {
    const core = page(choice, resolution);
    const { asOf, result } = await scan(choice, resolution);
    expect(asOf, `${choice} ${resolution}`).toBe(end);
    expect(result.primary, `${choice} ${resolution}`).toEqual(core.market!.primary);
    expect(result.fragility, `${choice} ${resolution}`).toEqual(core.fragility);
    if (core.market?.primary?.p != null) tested++;
  }
  // Most windows have a real test to compare, not two missing ones.
  expect(tested).toBeGreaterThanOrEqual(4);
}

describe("a frozen scan's candidate is tested as its frozen page", () => {
  it("for a market still open at the as-of time, ending there", async () => {
    stubWorld([LIVE_MARKET]);
    await expectSame(await marketPage("NVDA", LIVE_MARKET.ticker), await scanned("NVDA", LIVE_MARKET.ticker), AS_OF);
  });

  it("for a market that had closed by then, ending at its close, without the store", async () => {
    stubWorld([CLOSED_MARKET]);
    const list = await tickerCandidates([CLOSED_MARKET.ticker], Date.now(), AS_OF);
    expect(list.ok && list.data.candidates[0].end).toBe(CLOSED_MARKET.close);
    // Live, without the store, the scan (like the page) would end it now.
    const live = await tickerCandidates([CLOSED_MARKET.ticker]);
    expect(live.ok && live.data.candidates[0].end).toBeNull();
    await expectSame(await marketPage("TLT", CLOSED_MARKET.ticker), await scanned("TLT", CLOSED_MARKET.ticker), CLOSED_MARKET.close);
  });

  it("for a whole event's expected value", async () => {
    stubWorld(LONG_EVENT);
    await expectSame(await eventPage("TLT", "KXFEDDECISION-26DEC"), await scanned("TLT", "KXFEDDECISION-26DEC"), AS_OF);
  });
});

/** The world's upstreams, with the scan's routes answered by their loaders, as the routes read them. */
function stubScanRoutes(urls: string[]) {
  stubWorld([LIVE_MARKET, ...LONG_EVENT.filter((m) => m.ticker !== LIVE_MARKET.ticker)]);
  const world = globalThis.fetch;
  vi.stubGlobal("fetch", async (input: string | URL) => {
    const url = new URL(String(input), "http://localhost");
    if (url.pathname === SCAN_PRICES_PATH || url.pathname === SCAN_CANDIDATE_PATH) urls.push(`${url.pathname}${url.search}`);
    const asOf = parseScanAsOf(url.searchParams, Date.now());
    if (!asOf.ok) return Response.json({ error: { code: "invalid_asof", message: asOf.message } }, { status: 400 });
    if (url.pathname === SCAN_PRICES_PATH) {
      const span = parseSpan(url.searchParams, Date.now());
      if (!span.ok) return Response.json({ error: { code: "invalid_span", message: span.message } }, { status: 400 });
      const prices = await getScanPrices(url.searchParams.get("stock")!, span.value, asOf.value);
      return prices.ok ? Response.json(prices.data) : Response.json({ error: prices.error }, { status: 503 });
    }
    if (url.pathname === SCAN_CANDIDATE_PATH) {
      const r = await loadCandidateKalshi(url.searchParams.get("ticker")!, url.searchParams.get("kind") as "event" | "market", url.searchParams.get("long") === "1", asOf.value);
      return r.ok ? Response.json(r.data) : Response.json({ error: r.error }, { status: 422 });
    }
    return world(input);
  });
}

function finished(run: ScanRunClass): Promise<ScanSnapshot> {
  return new Promise((resolve) => {
    const check = () => {
      const s = run.getSnapshot();
      if (s.phase === "done" || s.phase === "failed") resolve(s);
    };
    run.subscribe(check);
    check();
  });
}

describe("a frozen scan run", () => {
  it("sends its as-of time with every request, and each result is its frozen page's", async () => {
    const urls: string[] = [];
    stubScanRoutes(urls);
    const list = await tickerCandidates([LIVE_MARKET.ticker], Date.now(), AS_OF);
    if (!list.ok) throw new Error("expected candidates");
    const run = new ScanRun({ stock: "NVDA", choice: 90, resolution: "hourly", candidates: list.data.candidates, asOf: AS_OF });
    const snap = await finished(run);
    expect(snap.phase).toBe("done");
    expect(urls.length).toBeGreaterThanOrEqual(2);
    for (const u of urls) expect(u).toContain(`asof=${AS_OF}`);
    expect(urls.find((u) => u.startsWith(SCAN_PRICES_PATH))).toContain("live=0");

    const state = snap.states[0];
    if (state.status !== "done") throw new Error("expected a result");
    const page = await marketPage("NVDA", LIVE_MARKET.ticker);
    expect((state.test as ScanTest).primary).toEqual(page(90, "hourly").market!.primary);
    expect(state.asOf).toBe(AS_OF);
    run.dispose();
  });
});
