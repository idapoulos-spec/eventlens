// A frozen link gives the numbers its page showed. The page is loaded live at awkward moments
// (minutes after a top of the hour, just after the close, a weekend, before the open, with the
// benchmark from memory), then, days later, from a link frozen at the time its windows ended
// (the rows' asOf): the rows and every result must be the same, with the store off or on. The
// fake world (test-world.ts) serves the same bars and candles whatever a request asks for, as
// the real APIs would for settled data; its scenarios are read here, never changed.

import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { expectedVariable, probabilityVariable, type KalshiVariable } from "@/lib/analytics/variable";
import { panelCore, panelEvents, panelResults, secondaryDetectable, secondaryLeaveOneOut, type PanelInput, type Returns } from "@/lib/analytics/panel";
import type { Resolution, ResearchRow } from "@/lib/analytics/research";
import { windowEndSec } from "@/lib/kalshi/client";
import { benchmarkFrom } from "@/lib/market-data/benchmark-series";
import { timeZoneOffsetMs } from "@/lib/market-data/session";
import type { BenchmarkSeries } from "@/lib/market-data/types";
import type { getBenchmarkSeries as GetBenchmarkSeries } from "@/lib/market-data/benchmark";
import type { Result } from "@/lib/result";
import { createTestDb, type TestDb } from "@/lib/store/test-db";
import type { loadEventAnalysis as LoadEventAnalysis } from "@/lib/expected/load";
import type { loadAnalysis as LoadAnalysis } from "./analysis";
import { eventLongRows, eventResearchRows, lastRows, marketLongRows, marketResearchRows, type LongRows, type ResearchRows } from "./rows";
import { seedCandles, seedCoverage, seedMarket, seedRun } from "./test-fixtures";
import { DAY_MS, HOUR_MS, stubWorld, worldEvent, worldMarket, type WorldMarket } from "./test-world";
import { KALSHI_HISTORY_MS, STOCK_HISTORY_MS } from "./window";

vi.setConfig({ testTimeout: 120_000 });
vi.mock("server-only", () => ({}));
const appSql = vi.hoisted(() => vi.fn());
vi.mock("@/lib/store/db", () => ({ getAppSql: appSql }));

// The golden pins' scenarios (research-golden.test.ts).
const LIVE_MARKET = worldMarket("KXFEDDECISION-26DEC-H0", { status: "active", open: Date.UTC(2025, 4, 1), close: Date.UTC(2026, 11, 9, 19), archived: false });
// The event with every book valid over its whole life (as research-golden.test.ts reads the longer windows).
const LONG_EVENT = worldEvent("KXFEDDECISION-26DEC", { status: "active", open: Date.UTC(2025, 5, 2, 14), close: Date.UTC(2026, 11, 9, 19), archived: false }, { bounded: true });

// New York is UTC−4 in early October 2026.
const ny = (day: number, hour: number, minute: number, second = 0) => Date.UTC(2026, 9, day, hour + 4, minute, second);
const MOMENTS = {
  "2 minutes after a top of the hour (its bar hasn't settled)": ny(7, 14, 2, 10),
  "mid-session, with the benchmark from memory": ny(7, 12, 40, 30),
  "3 minutes after the close (today's close isn't settled for the benchmark)": ny(7, 16, 3),
  "a Saturday": ny(10, 12, 0),
  "before the open": ny(8, 9, 10),
};
const FROM_MEMORY = "mid-session, with the benchmark from memory";
const LATER = 3 * DAY_MS;

const COMBOS: [number, Resolution][] = [
  [7, "hourly"],
  [30, "hourly"],
  [30, "daily"],
  [90, "hourly"],
  [90, "daily"],
];

const sha = (text: string) => createHash("sha256").update(text).digest("hex").slice(0, 16);

/**
 * JSON at 9 significant digits, without steps: a daily row's step is its position in the daily
 * bars loaded, and a frozen window's daily bars start a few weeks later than a live one's. Every
 * result reads steps relative to each other (`relativeSteps` checks rows separately), including
 * the fragility diagnostics' blocks, counted from their sample's first step (`blocking.first`).
 */
function canon(value: unknown): string {
  return JSON.stringify(value, function (key, v) {
    if (key === "step" || (key === "first" && typeof this === "object" && this !== null && "runDays" in this)) return undefined;
    if (typeof v === "number" && Number.isFinite(v)) return Number(v.toPrecision(9));
    if (ArrayBuffer.isView(v) && !(v instanceof DataView)) return Array.from(v as unknown as ArrayLike<number>, (x) => Number(x.toPrecision(9)));
    return v;
  });
}

const relativeSteps = (rows: ResearchRow[]) => rows.map((r) => r.step - (rows[0]?.step ?? 0));

interface Page {
  rows: ResearchRows;
  long: LongRows | null;
  /** The benchmark as the page hands it to the panel. */
  benchmark: BenchmarkSeries;
  variable: KalshiVariable;
}

/** Everything the panel shows for the page's rows, hashed per window, resolution, and returns. */
function results({ rows, benchmark, variable }: Page): Record<string, string> {
  const loaded = lastRows(rows);
  const out: Record<string, string> = {};
  for (const [days, resolution] of COMBOS) {
    for (const returns of ["raw", "adjusted"] as Returns[]) {
      const input: PanelInput = {
        full: resolution === "hourly" ? loaded.hourly : loaded.daily,
        from: loaded.asOf - days * DAY_MS,
        resolution,
        scale: variable.scale,
        closes: resolution === "hourly" ? benchmark.hourly : benchmark.daily,
        returns,
      };
      const core = panelCore(input);
      const panel = panelResults(core, panelEvents(input, core, variable.defaultThreshold[resolution]));
      const secondary = { detectable: secondaryDetectable(core, resolution), leaveOneOut: days === 90 && returns === "adjusted" ? secondaryLeaveOneOut(input, core) : null };
      out[`${days}${resolution[0]} ${returns}`] = sha(canon({ panel, secondary }));
    }
  }
  return out;
}

function expectSamePage(frozen: Page, live: Page) {
  expect(frozen.rows.asOf).toBe(live.rows.asOf);
  for (const r of ["hourly", "daily"] as const) {
    const [f, l] = [lastRows(frozen.rows)[r], lastRows(live.rows)[r]];
    expect(canon(f)).toBe(canon(l));
    expect(relativeSteps(f)).toEqual(relativeSteps(l));
    if (live.long) {
      expect(canon(frozen.long![r])).toBe(canon(live.long[r]));
      expect(relativeSteps(frozen.long![r])).toEqual(relativeSteps(live.long[r]));
    }
  }
  expect(frozen.long?.start).toBe(live.long?.start);
  expect(canon({ ...frozen.benchmark, fetchedAt: 0 })).toBe(canon({ ...live.benchmark, fetchedAt: 0 }));
  const [f, l] = [results(frozen), results(live)];
  expect(Object.keys(l).filter((k) => f[k] !== l[k])).toEqual([]);
}

let db: TestDb;
let loadAnalysis: typeof LoadAnalysis;
let loadEventAnalysis: typeof LoadEventAnalysis;
let getBenchmarkSeries: typeof GetBenchmarkSeries;

/** A fresh server instance (nothing in memory), as a frozen link opened days later would meet. */
async function freshServer() {
  vi.resetModules();
  ({ loadAnalysis } = await import("./analysis"));
  ({ loadEventAnalysis } = await import("@/lib/expected/load"));
  ({ getBenchmarkSeries } = await import("@/lib/market-data/benchmark"));
}

beforeEach(async () => {
  vi.stubEnv("TWELVE_DATA_API_KEY", "test-key");
  vi.useFakeTimers({ toFake: ["Date"] });
  await freshServer();
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

const withStore = <T,>(load: () => Promise<T>) =>
  db.asRole("eventlens_app", (sql) => {
    appSql.mockReturnValue(sql);
    return load();
  });

function benchmarkOf(b: Result<BenchmarkSeries> | null, from: number): BenchmarkSeries {
  if (!b?.ok) throw new Error("expected a benchmark");
  return benchmarkFrom(b.data, from);
}

/** A market's page, as components/Research.tsx builds its rows and hands the panel its benchmark. */
async function marketPage(stock: string, kalshi: string, asOf: number | null = null): Promise<Page> {
  const { kalshiData, stockData, researchHistory, benchmarkData, longHistory } = loadAnalysis(stock, kalshi, { asOf });
  const [k, s, h, b, l] = await Promise.all([kalshiData, stockData, researchHistory, benchmarkData, longHistory]);
  if (!k.ok || !s.ok || !h.ok || !l.ok) throw new Error("expected an analysis");
  const closeTime = Date.parse(k.data.market.closeTime!);
  const side = { research: s.data.research, fetchedAt: s.data.historyFetchedAt };
  const rows = marketResearchRows({ kalshi: h.data.points, closeTime, ...side });
  return {
    rows,
    long: l.data && marketLongRows({ history: l.data, closeTime, ...side }),
    benchmark: benchmarkOf(b, Math.min(s.data.research.longStart, rows.asOf - STOCK_HISTORY_MS)),
    variable: probabilityVariable(k.data.market.subtitle ?? k.data.market.title),
  };
}

/** An event's page, as components/event/EventDashboard.tsx builds it. */
async function eventPage(stock: string, ticker: string, asOf: number | null = null): Promise<Page> {
  const { event, stockData, benchmarkData, long } = loadEventAnalysis(stock, ticker, { asOf });
  const [e, s, b, l] = await Promise.all([event, stockData, benchmarkData, long]);
  if (!e.ok || !s.ok || !l.ok) throw new Error("expected an analysis");
  const side = { research: s.data.research, fetchedAt: s.data.historyFetchedAt };
  const rows = eventResearchRows({ marks: e.data.marks, ...side });
  return {
    rows,
    long: l.data && eventLongRows({ marks: l.data.marks, start: l.data.start, ...side }),
    benchmark: benchmarkOf(b, Math.min(s.data.research.longStart, rows.asOf - STOCK_HISTORY_MS)),
    variable: expectedVariable(e.data),
  };
}

/** Whether New York's regular session is under way at `t`. */
function inSession(t: number): boolean {
  const local = t + timeZoneOffsetMs(t, "America/New_York");
  const day = new Date(local).getUTCDay();
  const minute = (local % DAY_MS) / 60_000;
  return day >= 1 && day <= 5 && minute >= 9.5 * 60 && minute < 16 * 60;
}

/**
 * The world, with Twelve Data's quote saying the market is open only during the session (the
 * world's says it always is, which its pinned scenarios rely on), so a page loaded after the
 * close counts that day's session as complete, as the real one does.
 */
function stubRealWorld(markets: WorldMarket[]): string[] {
  const requests = stubWorld(markets);
  const world = globalThis.fetch;
  vi.stubGlobal("fetch", async (input: string | URL) => {
    const res = await world(input);
    if (new URL(String(input)).pathname !== "/quote") return res;
    return Response.json({ ...(await res.json()), is_market_open: inSession(Date.now()) });
  });
  return requests;
}

/** The live page at `moment`; with the benchmark loaded 3 minutes earlier (still in memory) when asked. */
async function livePage(load: (asOf?: number | null) => Promise<Page>, moment: number, benchmarkFromMemory: boolean): Promise<Page> {
  if (benchmarkFromMemory) {
    vi.setSystemTime(moment - 3 * 60_000);
    const warm = await getBenchmarkSeries("SPY");
    if (!warm.ok) throw new Error("expected the benchmark");
  }
  vi.setSystemTime(moment);
  return load();
}

describe("a frozen link gives its page's numbers", () => {
  for (const [name, moment] of Object.entries(MOMENTS)) {
    it(`for a live market, frozen ${name}`, async () => {
      stubRealWorld([LIVE_MARKET]);
      const live = await livePage(() => marketPage("NVDA", LIVE_MARKET.ticker), moment, name === FROM_MEMORY);
      expect(live.long).not.toBeNull();

      await freshServer();
      vi.setSystemTime(moment + LATER);
      const frozen = await marketPage("NVDA", LIVE_MARKET.ticker, live.rows.asOf);
      expectSamePage(frozen, live);
    });
  }

  it("for a live market, frozen from the store (a later collector run stored the candles)", async () => {
    stubRealWorld([LIVE_MARKET]);
    const moment = MOMENTS["2 minutes after a top of the hour (its bar hasn't settled)"];
    const live = await livePage(() => marketPage("NVDA", LIVE_MARKET.ticker), moment, false);
    await freshServer();
    vi.setSystemTime(moment + LATER);
    await store([LIVE_MARKET]);
    expectSamePage(await withStore(() => marketPage("NVDA", LIVE_MARKET.ticker, live.rows.asOf)), live);
  });

  for (const name of ["2 minutes after a top of the hour (its bar hasn't settled)", "3 minutes after the close (today's close isn't settled for the benchmark)"] as const) {
    it(`for a live event, frozen ${name}`, async () => {
      stubRealWorld(LONG_EVENT);
      const live = await livePage(() => eventPage("TLT", "KXFEDDECISION-26DEC"), MOMENTS[name], false);
      await freshServer();
      vi.setSystemTime(MOMENTS[name] + LATER);
      expectSamePage(await eventPage("TLT", "KXFEDDECISION-26DEC", live.rows.asOf), live);
    });
  }
});

describe("a frozen link's requests", () => {
  it("cost the usual 5 Twelve Data credits, with every bar and candle request ending at the as-of time", async () => {
    const asOf = MOMENTS["2 minutes after a top of the hour (its bar hasn't settled)"];
    vi.setSystemTime(asOf + LATER);
    const requests = stubRealWorld([LIVE_MARKET]);
    const page = await marketPage("NVDA", LIVE_MARKET.ticker, asOf);
    expect(page.rows.asOf).toBe(asOf);

    const twelve = requests.filter((r) => r.startsWith("twelvedata"));
    expect(twelve).toHaveLength(5);
    // The quote, then each symbol's bars over the window: 30-minute to the day after the as-of time; daily (the panel's) to today.
    expect(twelve.filter((r) => r === "twelvedata /quote symbol=NVDA")).toHaveLength(1);
    expect(twelve.filter((r) => r.includes("interval=30min") && r.includes("end_date=2026-10-08"))).toHaveLength(2);
    expect(twelve.filter((r) => r.includes("symbol=SPY") && r.includes("interval=1day") && r.includes("end_date=2026-10-08"))).toHaveLength(1);

    // Research's 97 days of Kalshi history end at the as-of time's minute.
    const endSec = windowEndSec(asOf);
    expect(requests).toContain(
      `kalshi /markets/candlesticks market_tickers=${LIVE_MARKET.ticker} start_ts=${endSec - KALSHI_HISTORY_MS / 1000} end_ts=${endSec} period_interval=60`,
    );
    // So do the longer windows' (the last of their requests); only the Kalshi panel's 7 days reach now.
    const hourly = requests.filter((r) => r.endsWith("period_interval=60"));
    const panel = hourly.filter((r) => r.includes(`end_ts=${windowEndSec(asOf + LATER)} `));
    expect(panel).toHaveLength(1);
    const research = hourly.filter((r) => !panel.includes(r));
    expect(research.every((r) => Number(/end_ts=(\d+)/.exec(r)![1]) <= endSec)).toBe(true);
    expect(research.filter((r) => r.includes(`end_ts=${endSec} `))).toHaveLength(2);
  });

  it("are a live page's without one", async () => {
    vi.setSystemTime(MOMENTS[FROM_MEMORY]);
    const live = stubWorld([LIVE_MARKET]);
    await marketPage("NVDA", LIVE_MARKET.ticker);
    await freshServer();
    const again = stubWorld([LIVE_MARKET]);
    await marketPage("NVDA", LIVE_MARKET.ticker, null);
    expect(again).toEqual(live);
    expect(live.filter((r) => r.startsWith("twelvedata"))).toHaveLength(5);
    expect(live.some((r) => r.includes("end_date"))).toBe(false);
  });
});
