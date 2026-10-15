// Pins what Research shows at its 7, 30, and 90-day windows, end to end: the loaders read a fake
// world (Twelve Data bars, Kalshi markets and events, and the store), the rows are built as the
// pages build them, and the panel's results are computed as the panel computes them. Taken before
// the longer windows were added (feat/long-windows), so they hold the existing windows to exactly
// what they were. Numbers are hashed at 9 significant digits, as in single-market-golden.test.ts.

import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { expectedVariable, probabilityVariable, type KalshiVariable } from "@/lib/analytics/variable";
import { adjustedView, closesByTime, primaryDetectable, windowAnalysis, windowMarket } from "@/lib/analytics/panel";
import type { Resolution } from "@/lib/analytics/research";
import type { BenchmarkSeries } from "@/lib/market-data/types";
import type { Result } from "@/lib/result";
import { createTestDb, type TestDb } from "@/lib/store/test-db";
import type { loadEventAnalysis as LoadEventAnalysis } from "@/lib/expected/load";
import type { loadAnalysis as LoadAnalysis } from "./analysis";
import { eventLongRows, eventResearchRows, lastRows, marketLongRows, marketResearchRows, type LongRows, type ResearchRows } from "./rows";
import { seedCandles, seedCoverage, seedMarket, seedRun } from "./test-fixtures";
import { HOUR_MS, stubWorld, worldEvent, worldMarket, type WorldMarket } from "./test-world";

vi.mock("server-only", () => ({}));
const appSql = vi.hoisted(() => vi.fn());
vi.mock("@/lib/store/db", () => ({ getAppSql: appSql }));

// Wednesday, Oct 7, 2026, 12:40 PM New York: the market is open.
const NOW = Date.UTC(2026, 9, 7, 16, 40, 30);
const LIVE_MARKET = worldMarket("KXFEDDECISION-26DEC-H0", { status: "active", open: Date.UTC(2025, 4, 1), close: Date.UTC(2026, 11, 9, 19), archived: false });
const SETTLED = { status: "finalized" as const, open: Date.UTC(2025, 2, 3, 14), close: Date.UTC(2025, 11, 10, 19), archived: true };
const SETTLED_MARKET = worldMarket("KXFEDDECISION-25DEC-H0", SETTLED);
const LIVE_EVENT = worldEvent("KXFEDDECISION-26DEC", { status: "active", open: Date.UTC(2025, 5, 2, 14), close: Date.UTC(2026, 11, 9, 19), archived: false });
const SETTLED_EVENT = worldEvent("KXFEDDECISION-25DEC", SETTLED);
// The same event with every book valid over its whole life, for the longer windows (LIVE_EVENT's
// unbounded walk, which the pins above use, drifts out of range months before the 90 days).
const LONG_EVENT = worldEvent("KXFEDDECISION-26DEC", { status: "active", open: Date.UTC(2025, 5, 2, 14), close: Date.UTC(2026, 11, 9, 19), archived: false }, { bounded: true });

const sha = (text: string) => createHash("sha256").update(text).digest("hex").slice(0, 16);

/** JSON with typed arrays as plain arrays and numbers to 9 significant digits (Math.log can differ in its last bit between CPUs). */
function canon(value: unknown): string {
  return JSON.stringify(value, (_key, v) => {
    if (typeof v === "number" && Number.isFinite(v)) return Number(v.toPrecision(9));
    if (ArrayBuffer.isView(v) && !(v instanceof DataView)) return Array.from(v as unknown as ArrayLike<number>, (x) => Number(x.toPrecision(9)));
    return v;
  });
}

/** The windows and resolutions the panel offers: 7 days is hourly only. */
const COMBOS: [number, Resolution][] = [
  [7, "hourly"],
  [30, "hourly"],
  [30, "daily"],
  [90, "hourly"],
  [90, "daily"],
];

/** Hashes of the rows the panel gets and of everything it computes from them at each window. */
function panelHashes(loaded: ResearchRows, benchmark: BenchmarkSeries, variable: KalshiVariable): Record<string, string> {
  const rows = lastRows(loaded);
  const out: Record<string, string> = { rows: sha(canon(rows)) };
  for (const [days, resolution] of COMBOS) {
    const full = resolution === "hourly" ? rows.hourly : rows.daily;
    const analysis = windowAnalysis({ full, asOf: rows.asOf, days, resolution, threshold: variable.defaultThreshold[resolution], scale: variable.scale });
    const market = windowMarket(analysis, closesByTime(benchmark, resolution), resolution, variable.scale);
    const results = { series: analysis.series, raw: analysis.raw, market, adjusted: adjustedView(market, resolution), detectable: primaryDetectable(market, resolution) };
    out[`${days}${resolution[0]}`] = sha(canon(results));
  }
  return out;
}

let db: TestDb;
let loadAnalysis: typeof LoadAnalysis;
let loadEventAnalysis: typeof LoadEventAnalysis;

beforeEach(async () => {
  vi.stubEnv("TWELVE_DATA_API_KEY", "test-key");
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  // Bars and benchmarks are kept in module memory, so each test loads fresh copies.
  vi.resetModules();
  ({ loadAnalysis } = await import("./analysis"));
  ({ loadEventAnalysis } = await import("@/lib/expected/load"));
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

/** Stores markets, their candles, and coverage from their open through an hour after their close. */
async function store(markets: WorldMarket[]) {
  const run = await seedRun(db.sql);
  for (const m of markets) {
    const id = await seedMarket(db.sql, { ticker: m.ticker, status: m.status, openTime: m.open, closeTime: m.close, raw: m.raw });
    await seedCandles(db.sql, run, id, m.quotes.map((q) => ({ t: q.t, bid: q.bid / 100, ask: q.ask / 100 })));
    await seedCoverage(db.sql, run, "kalshi", m.ticker, "60", m.open, m.close + HOUR_MS);
  }
}

/** Runs `load` with the store on, as the app's role. */
const withStore = <T>(load: () => Promise<T>) =>
  db.asRole("eventlens_app", (sql) => {
    appSql.mockReturnValue(sql);
    return load();
  });

function benchmarkOf(b: Result<BenchmarkSeries> | null): BenchmarkSeries {
  if (!b?.ok) throw new Error("expected a benchmark");
  return b.data;
}

async function marketHashes(stock: string, kalshi: string) {
  const { kalshiData, stockData, researchHistory, benchmarkData } = loadAnalysis(stock, kalshi);
  const [k, s, h, b] = await Promise.all([kalshiData, stockData, researchHistory, benchmarkData]);
  if (!k.ok || !s.ok || !h.ok) throw new Error("expected an analysis");
  const closeTime = k.data.market.closeTime === null ? null : Date.parse(k.data.market.closeTime);
  const rows = marketResearchRows({ kalshi: h.data.points, closeTime, research: s.data.research, fetchedAt: s.data.historyFetchedAt });
  return panelHashes(rows, benchmarkOf(b), probabilityVariable(k.data.market.subtitle ?? k.data.market.title));
}

async function eventHashes(stock: string, ticker: string) {
  const { event, stockData, benchmarkData } = loadEventAnalysis(stock, ticker);
  const [e, s, b] = await Promise.all([event, stockData, benchmarkData]);
  if (!e.ok || !s.ok) throw new Error("expected an analysis");
  const rows = eventResearchRows({ marks: e.data.marks, research: s.data.research, fetchedAt: s.data.historyFetchedAt });
  return panelHashes(rows, benchmarkOf(b), expectedVariable(e.data));
}

describe("Research at 7, 30, and 90 days is unchanged", () => {
  it("for a live market, without the store", async () => {
    stubWorld([LIVE_MARKET]);
    expect(await marketHashes("NVDA", LIVE_MARKET.ticker)).toEqual({
      rows: "5ef52d1252ed8538",
      "7h": "69d753013be89564",
      "30h": "ad3c6de497e98ab4",
      "30d": "17d85d4830b82cf6",
      "90h": "5f1596ff1d697e6d",
      "90d": "de829648b74234ff",
    });
  });

  it("for a market settled before the archive cutoff, from the store, ending at its close", async () => {
    stubWorld([SETTLED_MARKET]);
    await store([SETTLED_MARKET]);
    expect(await withStore(() => marketHashes("TLT", SETTLED_MARKET.ticker))).toEqual({
      rows: "2ab322ad0d42a6c9",
      "7h": "390e89be7a621c87",
      "30h": "26ac5a16a4e2e9bb",
      "30d": "25bb95a51b6005e7",
      "90h": "d31568057963a2b3",
      "90d": "7da4cbcc735ab11c",
    });
  });

  it("for a live event, without the store", async () => {
    stubWorld(LIVE_EVENT);
    expect(await eventHashes("TLT", "KXFEDDECISION-26DEC")).toEqual({
      rows: "ad022166c323d8a6",
      "7h": "d5cc2e033a0a06f5",
      "30h": "71f0459e15ddfd47",
      "30d": "0f5f9ff2b9251637",
      "90h": "b23896cf7054108d",
      "90d": "a8c13041b1d1c0d5",
    });
  });

  it("for an event settled before the archive cutoff, from the store, ending at its first close", async () => {
    stubWorld(SETTLED_EVENT);
    await store(SETTLED_EVENT);
    expect(await withStore(() => eventHashes("NVDA", "KXFEDDECISION-25DEC"))).toEqual({
      rows: "1e60172f77c6196e",
      "7h": "401b03b74a1c0c9a",
      "30h": "75ae32202e0c81c1",
      "30d": "56308dbf2428511a",
      "90h": "640d448534a15ee7",
      "90d": "2f8c221336cc7cbe",
    });
  });
});

/** The longer windows' rows that fall in the 90 days: the same as the 90-day rows, but daily steps (positions in a longer list). */
function overlap(long: LongRows, rows: ResearchRows) {
  const recent = lastRows(rows);
  const byT = (list: { t: number }[]) => new Map(list.map((r) => [r.t, r]));
  const hourly = byT(long.hourly);
  const daily = byT(long.daily);
  return {
    hourly: recent.hourly.map((r) => hourly.get(r.t)),
    daily: recent.daily.map((r) => {
      const d = daily.get(r.t) as (typeof recent.daily)[number] | undefined;
      return d && { ...d, step: r.step };
    }),
    recent,
  };
}

describe("the longer windows' rows", () => {
  it("for a market, start at its open and agree with the 90 days where they overlap", async () => {
    stubWorld([LIVE_MARKET]);
    const { kalshiData, stockData, researchHistory, longHistory } = loadAnalysis("NVDA", LIVE_MARKET.ticker);
    const [k, s, h, l] = await Promise.all([kalshiData, stockData, researchHistory, longHistory]);
    if (!k.ok || !s.ok || !h.ok || !l.ok || !l.data) throw new Error("expected an analysis with longer windows");
    const side = { research: s.data.research, fetchedAt: s.data.historyFetchedAt };
    const closeTime = Date.parse(k.data.market.closeTime!);
    const long = marketLongRows({ history: l.data, closeTime, ...side });
    const rows = marketResearchRows({ kalshi: h.data.points, closeTime, ...side });

    expect(long.start).toBe(LIVE_MARKET.open);
    expect(long.hourly[0].t).toBeGreaterThanOrEqual(LIVE_MARKET.open);
    expect(long.hourly.length).toBeGreaterThan(330 * 7 * 5 / 7);
    const { hourly, daily, recent } = overlap(long, rows);
    expect(hourly).toEqual(recent.hourly);
    expect(daily).toEqual(recent.daily);
  });

  it("for an event, start at its first outcome's open and agree with the 90 days where they overlap", async () => {
    stubWorld(LONG_EVENT);
    const { event, stockData, long: longMarks } = loadEventAnalysis("TLT", "KXFEDDECISION-26DEC");
    const [e, s, l] = await Promise.all([event, stockData, longMarks]);
    if (!e.ok || !s.ok || !l.ok || !l.data) throw new Error("expected an analysis with longer windows");
    const side = { research: s.data.research, fetchedAt: s.data.historyFetchedAt };
    const long = eventLongRows({ marks: l.data.marks, start: l.data.start, ...side });
    const rows = eventResearchRows({ marks: e.data.marks, ...side });

    expect(long.start).toBe(LONG_EVENT[0].open);
    const { hourly, daily, recent } = overlap(long, rows);
    expect(hourly).toEqual(recent.hourly);
    expect(daily).toEqual(recent.daily);
  });
});

