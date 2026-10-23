// A scan's result for a candidate is its own page's: through the loaders, against the fake world
// the golden pins use (research-golden.test.ts; its scenarios are read, never changed), the scan's
// prices (one download for the scan), its Kalshi side, and its rows give the same primary test and
// fragility diagnostics as the page's own loaders, rows, and panel, at every window.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { panelCore, type PanelInput } from "@/lib/analytics/panel";
import { rowsSince, type Resolution } from "@/lib/analytics/research";
import { scanFirstStage } from "@/lib/analytics/scan";
import { eventLongRows, eventResearchRows, lastRows, marketLongRows, marketResearchRows, type LongRows, type ResearchRows } from "@/lib/history/rows";
import { seedCandles, seedCoverage, seedMarket, seedRun } from "@/lib/history/test-fixtures";
import { HOUR_MS, stubWorld, worldEvent, worldMarket, type WorldMarket } from "@/lib/history/test-world";
import { STOCK_HISTORY_MS, windowPlan, type WindowChoice } from "@/lib/history/window";
import { benchmarkFrom } from "@/lib/market-data/benchmark-series";
import type { BenchmarkSeries } from "@/lib/market-data/types";
import { ok, type Result } from "@/lib/result";
import { createTestDb, type TestDb } from "@/lib/store/test-db";
import type { loadEventAnalysis as LoadEventAnalysis } from "@/lib/expected/load";
import type { loadAnalysis as LoadAnalysis } from "@/lib/history/analysis";
import { scanStock } from "./bars";
import type { tickerCandidates as TickerCandidates } from "./candidates";
import type { loadCandidateKalshi as LoadCandidateKalshi } from "./load";
import type { getScanPrices as GetScanPrices } from "./prices";
import { candidateInput } from "./rows";
import { priceSpan } from "./span";

vi.setConfig({ testTimeout: 60_000 });
vi.mock("server-only", () => ({}));
const appSql = vi.hoisted(() => vi.fn());
vi.mock("@/lib/store/db", () => ({ getAppSql: appSql }));

// As in research-golden.test.ts: Wednesday, Oct 7, 2026, 12:40 PM New York, the market open.
const NOW = Date.UTC(2026, 9, 7, 16, 40, 30);
const LIVE_MARKET = worldMarket("KXFEDDECISION-26DEC-H0", { status: "active", open: Date.UTC(2025, 4, 1), close: Date.UTC(2026, 11, 9, 19), archived: false });
const SETTLED = { status: "finalized" as const, open: Date.UTC(2025, 2, 3, 14), close: Date.UTC(2025, 11, 10, 19), archived: true };
const SETTLED_MARKET = worldMarket("KXFEDDECISION-25DEC-H0", SETTLED);
const SETTLED_EVENT = worldEvent("KXFEDDECISION-25DEC", SETTLED);
const LONG_EVENT = worldEvent("KXFEDDECISION-26DEC", { status: "active", open: Date.UTC(2025, 5, 2, 14), close: Date.UTC(2026, 11, 9, 19), archived: false }, { bounded: true });

const CHOICES: [WindowChoice, Resolution][] = [
  [7, "hourly"],
  [30, "hourly"],
  [30, "daily"],
  [90, "hourly"],
  [90, "daily"],
  [180, "hourly"],
  [365, "daily"],
  ["all", "hourly"],
];

let db: TestDb;
let loadAnalysis: typeof LoadAnalysis;
let loadEventAnalysis: typeof LoadEventAnalysis;
let tickerCandidates: typeof TickerCandidates;
let loadCandidateKalshi: typeof LoadCandidateKalshi;
let getScanPrices: typeof GetScanPrices;

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
  db = await createTestDb();
  appSql.mockReturnValue(null);
});

afterEach(async () => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  appSql.mockReset();
  await db.close();
});

async function store(markets: WorldMarket[]) {
  const run = await seedRun(db.sql);
  for (const m of markets) {
    const id = await seedMarket(db.sql, { ticker: m.ticker, status: m.status, openTime: m.open, closeTime: m.close, raw: m.raw });
    await seedCandles(db.sql, run, id, m.quotes.map((q) => ({ t: q.t, bid: q.bid / 100, ask: q.ask / 100 })));
    await seedCoverage(db.sql, run, "kalshi", m.ticker, "60", m.open, m.close + HOUR_MS);
  }
}

const withStore = <T>(load: () => Promise<T>) =>
  db.asRole("eventlens_app", (sql) => {
    appSql.mockReturnValue(sql);
    return load();
  });

/** The page's panel input for a window, as ResearchPanel builds it. */
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

/** The page's primary test and fragility at each window, for a market. */
async function marketPage(stock: string, ticker: string) {
  const { kalshiData, stockData, researchHistory, benchmarkData, longHistory } = loadAnalysis(stock, ticker);
  const [k, s, h, b, l] = await Promise.all([kalshiData, stockData, researchHistory, benchmarkData, longHistory]);
  if (!k.ok || !s.ok || !h.ok || !l.ok) throw new Error("expected an analysis");
  const closeTime = Date.parse(k.data.market.closeTime!);
  const side = { research: s.data.research, fetchedAt: s.data.historyFetchedAt };
  const rows = marketResearchRows({ kalshi: h.data.points, closeTime, ...side });
  const long = l.data && marketLongRows({ history: l.data, closeTime, ...side });
  return (choice: WindowChoice, resolution: Resolution) => panelCore(pageInput(rows, long, benchmarkOf(b), s.data.research.longStart, 100, choice, resolution), { lags: false });
}

/** The same for an event. */
async function eventPage(stock: string, ticker: string) {
  const { event, stockData, benchmarkData, long: longMarks } = loadEventAnalysis(stock, ticker);
  const [e, s, b, l] = await Promise.all([event, stockData, benchmarkData, longMarks]);
  if (!e.ok || !s.ok || !l.ok) throw new Error("expected an analysis");
  const side = { research: s.data.research, fetchedAt: s.data.historyFetchedAt };
  const rows = eventResearchRows({ marks: e.data.marks, ...side });
  const long = l.data && eventLongRows({ marks: l.data.marks, start: l.data.start, ...side });
  return (choice: WindowChoice, resolution: Resolution) => panelCore(pageInput(rows, long, benchmarkOf(b), s.data.research.longStart, 1, choice, resolution), { lags: false });
}

/** The scan's result for the one candidate at each window, through its own routes' loaders. */
async function scanned(stock: string, ticker: string) {
  const list = await tickerCandidates([ticker]);
  if (!list.ok || list.data.candidates.length !== 1) throw new Error("expected one candidate");
  const [candidate] = list.data.candidates;
  return async (choice: WindowChoice, resolution: Resolution) => {
    const prices = await getScanPrices(stock, priceSpan([candidate], choice, Date.now())!);
    const kalshi = await loadCandidateKalshi(candidate.ticker, candidate.kind, choice === "all" || choice > 90);
    if (!prices.ok || !kalshi.ok) throw new Error("expected prices and a candidate");
    const input = candidateInput(scanStock(prices.data), prices.data.benchmark, kalshi.data, choice, resolution);
    if (!input.ok) throw new Error(input.error.message);
    return scanFirstStage(input.data.input);
  };
}

async function expectSame(page: (c: WindowChoice, r: Resolution) => ReturnType<typeof panelCore>, scan: (c: WindowChoice, r: Resolution) => Promise<ReturnType<typeof scanFirstStage>>) {
  for (const [choice, resolution] of CHOICES) {
    const core = page(choice, resolution);
    const result = await scan(choice, resolution);
    expect(result.primary, `${choice} ${resolution}`).toEqual(core.market!.primary);
    expect(result.fragility, `${choice} ${resolution}`).toEqual(core.fragility);
  }
}

describe("a scanned candidate's test is its page's", () => {
  it("for a live market, without the store", async () => {
    stubWorld([LIVE_MARKET]);
    await expectSame(await marketPage("NVDA", LIVE_MARKET.ticker), await scanned("NVDA", LIVE_MARKET.ticker));
  });

  it("for a market settled before the archive cutoff, from the store, ending at its close", async () => {
    stubWorld([SETTLED_MARKET]);
    await store([SETTLED_MARKET]);
    await withStore(async () => expectSame(await marketPage("TLT", SETTLED_MARKET.ticker), await scanned("TLT", SETTLED_MARKET.ticker)));
  });

  it("for a live event's expected value, without the store", async () => {
    stubWorld(LONG_EVENT);
    await expectSame(await eventPage("TLT", "KXFEDDECISION-26DEC"), await scanned("TLT", "KXFEDDECISION-26DEC"));
  });

  it("for an event settled before the archive cutoff, from the store, ending at its first close", async () => {
    stubWorld(SETTLED_EVENT);
    await store(SETTLED_EVENT);
    await withStore(async () => expectSame(await eventPage("NVDA", "KXFEDDECISION-25DEC"), await scanned("NVDA", "KXFEDDECISION-25DEC")));
  });
});

describe("a scan's prices", () => {
  it("cost 4 Twelve Data requests for windows that end now, one less than an analysis, and nothing again from memory", async () => {
    const requests = stubWorld([LIVE_MARKET]);
    const span = { from: NOW - 100 * 24 * HOUR_MS, to: NOW, live: true };
    const first = await getScanPrices("NVDA", span);
    expect(first.ok && first.data.requests).toBe(4);
    expect(requests.filter((r) => r.startsWith("twelvedata"))).toEqual([
      "twelvedata /time_series symbol=NVDA interval=30min outputsize=5000 start_date=2026-06-29",
      "twelvedata /time_series symbol=NVDA interval=1day outputsize=5000 start_date=2026-05-20",
      "twelvedata /time_series symbol=SPY interval=30min outputsize=5000 start_date=2025-04-15",
      "twelvedata /time_series symbol=SPY interval=1day outputsize=5000 start_date=2025-04-15",
    ]);
    // A second later (the benchmark counts as downloaded when it was fetched during the call).
    vi.setSystemTime(NOW + 1_000);
    const again = await getScanPrices("NVDA", span);
    expect(again.ok && again.data.requests).toBe(0);
  });

  it("split a span longer than 540 days into requests that each fit, with the benchmark's alongside", async () => {
    const requests = stubWorld([SETTLED_MARKET]);
    const span = { from: Date.UTC(2024, 9, 7), to: Date.UTC(2026, 6, 1), live: false };
    const prices = await getScanPrices("TLT", span);
    expect(prices.ok && prices.data.requests).toBe(6);
    expect(requests.filter((r) => r.startsWith("twelvedata"))).toHaveLength(6);
    // Bars on the shared date are kept once.
    const t = prices.ok ? prices.data.halfHourly.t : [];
    expect(new Set(t).size).toBe(t.length);
  });

  it("refuse a span that would take more than 8 requests", async () => {
    stubWorld([]);
    const prices = await getScanPrices("TLT", { from: Date.UTC(2021, 0, 4), to: NOW, live: true });
    expect(prices.ok).toBe(false);
    expect(!prices.ok && prices.error.code).toBe("too_long");
  });
});
