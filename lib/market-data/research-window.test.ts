// The stock and benchmark bars Research reads when its window ends at a closed market's close
// (with the data store on): what's requested from Twelve Data, and what the store replaces.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DAY_MS, HOUR_MS, seedBars, seedCoverage, seedRun } from "@/lib/history/test-fixtures";
import { createTestDb, type TestDb } from "@/lib/store/test-db";
import type { getBenchmarkSeries as GetBenchmarkSeries } from "./benchmark";
import type { getStockOverview as GetStockOverview } from "./twelve-data";

vi.mock("server-only", () => ({}));
const appSql = vi.hoisted(() => vi.fn());
vi.mock("@/lib/store/db", () => ({ getAppSql: appSql }));

const NOW = Date.UTC(2026, 9, 7, 20, 30); // 4:30 PM New York, after the close
// KXFEDDECISION-25DEC closed at 2:00 PM New York on Dec 10, 2025.
const END = Date.UTC(2025, 11, 10, 19);
const HALF_HOUR_MS = HOUR_MS / 2;

/** Weekdays (00:00 UTC) from `from` through `to`. */
function weekdays(from: number, to: number): number[] {
  const days: number[] = [];
  for (let d = Math.floor(from / DAY_MS) * DAY_MS; d <= to; d += DAY_MS) {
    if (![0, 6].includes(new Date(d).getUTCDay())) days.push(d);
  }
  return days;
}

const datetime = (ms: number) => new Date(ms).toISOString().slice(0, 19).replace("T", " ");
const ohlc = (close: number) => ({ open: String(close), high: String(close), low: String(close), close: String(close) });

/**
 * Fakes Twelve Data: 30-minute bars for each New York session (14:30–21:00 UTC in winter),
 * daily bars for each weekday, both within the requested dates, newest first, at most outputsize.
 */
function stubTwelveData() {
  const requests: URL[] = [];
  vi.stubGlobal("fetch", async (input: string | URL) => {
    const url = new URL(String(input));
    requests.push(url);
    if (url.pathname === "/quote") {
      return Response.json({ symbol: "NVDA", close: "180", datetime: "2026-10-07", is_market_open: false });
    }
    const q = url.searchParams;
    const from = q.get("start_date") ? Date.parse(`${q.get("start_date")}T00:00:00Z`) : NOW - 400 * DAY_MS;
    const to = q.get("end_date") ? Date.parse(`${q.get("end_date")}T00:00:00Z`) : NOW;
    const days = weekdays(from, to).filter((d) => d < to);
    const values =
      q.get("interval") === "1day"
        ? days.map((d) => ({ datetime: datetime(d).slice(0, 10), ...ohlc(100 + d / DAY_MS / 1000) }))
        : days.flatMap((d) =>
            Array.from({ length: 13 }, (_, i) => ({ t: d + 14.5 * HOUR_MS + i * HALF_HOUR_MS, close: 200 + i }))
              .filter(({ t }) => t + HALF_HOUR_MS <= NOW)
              .map(({ t, close }) => ({ datetime: datetime(t), ...ohlc(close) })),
          );
    const outputsize = Number(q.get("outputsize"));
    return Response.json({
      status: "ok",
      meta: { exchange_timezone: "America/New_York" },
      values: values.reverse().slice(0, outputsize),
    });
  });
  return requests;
}

const params = (u: URL) => Object.fromEntries([...u.searchParams].filter(([k]) => k !== "symbol" && k !== "timezone"));

let db: TestDb;
let getStockOverview: typeof GetStockOverview;
let getBenchmarkSeries: typeof GetBenchmarkSeries;

beforeEach(async () => {
  vi.stubEnv("TWELVE_DATA_API_KEY", "test-key");
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  // Bars and benchmarks are kept in module memory, so each test loads fresh copies.
  vi.resetModules();
  ({ getStockOverview } = await import("./twelve-data"));
  ({ getBenchmarkSeries } = await import("./benchmark"));
  db = await createTestDb();
  appSql.mockReturnValue(db.sql);
});

afterEach(async () => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  appSql.mockReset();
  await db.close();
});

/** Stores 30-minute and daily bars of `symbol` for the 100 days before END, covered completely. */
async function storeWindow(symbol: string) {
  const run = await seedRun(db.sql, "stocks");
  const days = weekdays(END - 100 * DAY_MS, END);
  await seedBars(
    db.sql,
    run,
    symbol,
    "30min",
    days.flatMap((d) => Array.from({ length: 13 }, (_, i) => ({ start: d + 14.5 * HOUR_MS + i * HALF_HOUR_MS, end: d + 15 * HOUR_MS + i * HALF_HOUR_MS, close: 300 + i }))),
  );
  await seedBars(db.sql, run, symbol, "1day", days.map((d) => ({ start: d, end: d + 21 * HOUR_MS, close: 400 })));
  for (const interval of ["30min", "1day"] as const) {
    await seedCoverage(db.sql, run, "twelve_data", symbol, interval, END - 101 * DAY_MS, NOW - DAY_MS);
  }
}

const window = { end: END, archived: true };

describe("getStockOverview with Research ending at a closed market's close", () => {
  it("spends the usual 3 credits: the window's 30-minute bars, and daily bars reaching back to it", async () => {
    const requests = stubTwelveData();
    const result = await getStockOverview("NVDA", Promise.resolve(window));
    if (!result.ok) throw new Error(result.error.code);

    expect(requests.map((u) => u.pathname).sort()).toEqual(["/quote", "/time_series", "/time_series"]);
    const series = requests.filter((u) => u.pathname === "/time_series").map(params);
    expect(series).toContainEqual({ interval: "30min", outputsize: "5000", start_date: "2025-09-01", end_date: "2025-12-11" });
    expect(series).toContainEqual({ interval: "1day", outputsize: "5000", start_date: "2025-09-01" });

    const { daily, research } = result.data;
    // The panel keeps the latest completed sessions, as before.
    expect(daily).toHaveLength(90);
    expect(daily.at(-1)?.t).toBe(Date.UTC(2026, 9, 7));
    // Research reads the window's bars.
    expect(research.end).toBe(END);
    expect(research.halfHourly.at(-1)?.t).toBe(Date.UTC(2025, 11, 10, 21));
    expect(research.daily[0].t).toBe(Date.UTC(2025, 8, 1));
    expect(research.daily.some((b) => b.t === Date.UTC(2025, 11, 10))).toBe(true);
  });

  it("reads the window from the store when it covers it, fetching only the latest daily bars", async () => {
    await storeWindow("NVDA");
    const requests = stubTwelveData();
    const result = await getStockOverview("NVDA", Promise.resolve(window));
    if (!result.ok) throw new Error(result.error.code);

    expect(requests.map(params)).toEqual([{}, { interval: "1day", outputsize: "90" }]);
    expect(result.data.research.halfHourly.every((b) => b.close >= 300)).toBe(true);
    expect(result.data.research.daily.every((b) => b.close === 400)).toBe(true);
    expect(result.data.daily).toHaveLength(90);
  });

  it("reads the latest bars, as before, when Research ends now; Research then reads the panel's bars", async () => {
    const requests = stubTwelveData();
    const result = await getStockOverview("NVDA");
    if (!result.ok) throw new Error(result.error.code);

    expect(requests.filter((u) => u.pathname === "/time_series").map(params)).toEqual([
      { interval: "30min", outputsize: "900" },
      { interval: "1day", outputsize: "90" },
    ]);
    expect(result.data.research).toEqual({ end: null, halfHourly: result.data.halfHourly, daily: result.data.daily });
  });

  it("keeps the latest bars and a window's bars apart in memory", async () => {
    const requests = stubTwelveData();
    await getStockOverview("NVDA");
    await getStockOverview("NVDA", window);
    await getStockOverview("NVDA");
    await getStockOverview("NVDA", window);
    // A quote every time, but each kind of history's two series only once.
    expect(requests.filter((u) => u.pathname === "/time_series")).toHaveLength(4);
  });
});

describe("getBenchmarkSeries for a window that ended in the past", () => {
  it("fetches the window's bars once, then keeps them: they can't change", async () => {
    const requests = stubTwelveData();
    const first = await getBenchmarkSeries("SPY", { end: END });
    if (!first.ok) throw new Error(first.error.code);
    expect(requests.map(params).sort((a, b) => a.interval.localeCompare(b.interval))).toEqual([
      { interval: "1day", outputsize: "5000", start_date: "2025-09-01", end_date: "2025-12-11" },
      { interval: "30min", outputsize: "5000", start_date: "2025-09-01", end_date: "2025-12-11" },
    ]);
    expect(first.data.hourly.some((p) => p.t === END)).toBe(true);

    vi.setSystemTime(NOW + 30 * DAY_MS);
    expect(await getBenchmarkSeries("SPY", { end: END })).toEqual(first);
    expect(requests).toHaveLength(2);
  });

  it("reads the window from the store when it covers it, spending no credits", async () => {
    await storeWindow("SPY");
    const requests = stubTwelveData();
    const result = await getBenchmarkSeries("SPY", { end: END });
    expect(requests).toEqual([]);
    expect(result.ok && result.data.hourly.length).toBeGreaterThan(0);
  });

  it("is a different entry from the latest bars", async () => {
    const requests = stubTwelveData();
    await getBenchmarkSeries("SPY");
    await getBenchmarkSeries("SPY", { end: END });
    expect(requests).toHaveLength(4);
  });
});
