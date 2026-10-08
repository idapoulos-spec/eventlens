import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getAppSql } from "@/lib/store/db";
import { createTestDb, type TestDb } from "@/lib/store/test-db";
import { getResearchHistory, TAIL_OVERLAP_MS } from "./research";
import { DAY_MS, HOUR_MS, seedCandles, seedCoverage, seedMarket, seedRun } from "./test-fixtures";
import { paths, stubKalshi, type FakeCandle } from "./test-kalshi";
import type { ResearchWindow } from "./types";
import { KALSHI_HISTORY_MS, LIVE_WINDOW } from "./window";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/store/db", () => ({ getAppSql: vi.fn(() => null) }));
const appSql = vi.mocked(getAppSql);

const TICKER = "KXFEDDECISION-26OCT-H0";
// 12:40:30 PM New York. Windows end at the start of the minute.
const NOW = Date.UTC(2026, 9, 7, 16, 40, 30);
const END = Date.UTC(2026, 9, 7, 16, 40);
const START = END - KALSHI_HISTORY_MS;
// The collector last fetched through 11 AM UTC.
const STORED_UNTIL = Date.UTC(2026, 9, 7, 11);

const hourly = (from: number, to: number, bid: number): FakeCandle[] => {
  const candles: FakeCandle[] = [];
  for (let t = Math.ceil(from / HOUR_MS) * HOUR_MS; t <= to; t += HOUR_MS) candles.push({ t, bid, ask: bid + 0.02 });
  return candles;
};

let db: TestDb;

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  db = await createTestDb();
});
afterEach(async () => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  appSql.mockReset();
  appSql.mockReturnValue(null);
  await db.close();
});

/** Runs `fn` with the store on, reading as the app's role. */
const withStore = <T,>(fn: () => Promise<T>) =>
  db.asRole("eventlens_app", (sql) => {
    appSql.mockReturnValue(sql);
    return fn();
  });

const history = (window: ResearchWindow = LIVE_WINDOW) => getResearchHistory(TICKER, Promise.resolve(window));

/** Stores an open market with hourly candles from START until STORED_UNTIL, covered from a day before. */
async function storeOpenMarket(coverage: [number, number][] = [[START - DAY_MS, STORED_UNTIL]]) {
  const run = await seedRun(db.sql);
  const id = await seedMarket(db.sql, { ticker: TICKER, status: "active", openTime: START - 30 * DAY_MS, closeTime: Date.UTC(2026, 9, 28, 18) });
  await seedCandles(db.sql, run, id, hourly(START, STORED_UNTIL, 0.3));
  for (const [from, to] of coverage) await seedCoverage(db.sql, run, "kalshi", TICKER, "60", from, to);
}

describe("getResearchHistory without the store", () => {
  it("makes exactly the request it always has: 97 days of hourly candles ending this minute", async () => {
    const calls = stubKalshi(TICKER, { candles: hourly(START, END, 0.4) });
    const result = await history();
    if (!result.ok) throw new Error(result.error.code);

    expect(calls).toHaveLength(1);
    expect(paths(calls)).toEqual(["/markets/candlesticks"]);
    expect(Object.fromEntries(calls[0].searchParams)).toEqual({
      market_tickers: TICKER,
      start_ts: String(START / 1000),
      end_ts: String(END / 1000),
      period_interval: "60",
    });
    expect(result.data.points).toHaveLength(97 * 24);
    expect(result.data.provenance).toEqual({ storedThrough: null, liveFrom: null, liveFailed: false });
  });
});

describe("getResearchHistory with the store", () => {
  it("adds a live tail to stored candles, overlapping by two hours, live winning", async () => {
    await storeOpenMarket();
    const calls = stubKalshi(TICKER, { candles: hourly(STORED_UNTIL - 2 * HOUR_MS, END, 0.5) });
    const result = await withStore(() => history());
    if (!result.ok) throw new Error(result.error.code);

    expect(paths(calls)).toEqual(["/markets/candlesticks"]);
    expect(Number(calls[0].searchParams.get("start_ts"))).toBe((STORED_UNTIL - TAIL_OVERLAP_MS) / 1000);
    expect(Number(calls[0].searchParams.get("end_ts"))).toBe(END / 1000);

    const { points, provenance } = result.data;
    expect(provenance).toEqual({ storedThrough: STORED_UNTIL, liveFrom: STORED_UNTIL - TAIL_OVERLAP_MS, liveFailed: false });
    // One point an hour, the stored ones up to the overlap and live ones from it.
    expect(points.map((p) => p.t)).toEqual(hourly(START, END, 0).map((c) => c.t));
    expect(points.find((p) => p.t === STORED_UNTIL - 3 * HOUR_MS)?.value).toBeCloseTo(0.31, 10);
    expect(points.find((p) => p.t === STORED_UNTIL - 2 * HOUR_MS)?.value).toBeCloseTo(0.51, 10);
  });

  it("serves stored candles alone, saying so, when the live tail fails", async () => {
    await storeOpenMarket();
    vi.spyOn(console, "warn").mockImplementation(() => {});
    stubKalshi(TICKER, { candleStatus: 500 });
    const result = await withStore(() => history());
    if (!result.ok) throw new Error(result.error.code);

    expect(result.data.provenance).toEqual({ storedThrough: STORED_UNTIL, liveFrom: null, liveFailed: true });
    expect(result.data.points.at(-1)?.t).toBe(STORED_UNTIL);
  });

  it("fetches the whole window live when coverage has a hole in it", async () => {
    await storeOpenMarket([
      [START - DAY_MS, START + 10 * DAY_MS],
      [START + 11 * DAY_MS, STORED_UNTIL],
    ]);
    const calls = stubKalshi(TICKER, { candles: hourly(START, END, 0.4) });
    const result = await withStore(() => history());
    if (!result.ok) throw new Error(result.error.code);

    expect(Number(calls[0].searchParams.get("start_ts"))).toBe(START / 1000);
    expect(result.data.provenance).toEqual({ storedThrough: null, liveFrom: START, liveFailed: false });
  });

  it("fetches the whole window live when the store fails, logging a fixed line", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    appSql.mockReturnValue({
      query: async () => {
        throw Object.assign(new Error("password authentication failed"), { code: "28P01" });
      },
    });
    const calls = stubKalshi(TICKER, { candles: hourly(START, END, 0.4) });
    const result = await history();

    expect(result.ok).toBe(true);
    expect(paths(calls)).toEqual(["/markets/candlesticks"]);
    expect(warn).toHaveBeenCalledWith("[store] Kalshi history unavailable (SQLSTATE 28P01); using live data");
  });

  describe("for a market settled before Kalshi's archive cutoff", () => {
    const CLOSE = Date.UTC(2025, 11, 10, 19);
    const OPEN = CLOSE - 400 * DAY_MS;
    const window: ResearchWindow = { end: CLOSE, archived: true };

    it("reads only the store when it covers the 97 days before the close", async () => {
      const run = await seedRun(db.sql);
      const id = await seedMarket(db.sql, { ticker: TICKER, status: "finalized", openTime: OPEN, closeTime: CLOSE });
      await seedCandles(db.sql, run, id, hourly(CLOSE - KALSHI_HISTORY_MS, CLOSE, 0.2));
      await seedCoverage(db.sql, run, "kalshi", TICKER, "60", OPEN, CLOSE + HOUR_MS);
      const calls = stubKalshi(TICKER, {});
      const result = await withStore(() => history(window));
      if (!result.ok) throw new Error(result.error.code);

      expect(calls).toEqual([]);
      expect(result.data.points).toHaveLength(97 * 24 + 1);
      expect(result.data.points.at(-1)?.t).toBe(CLOSE);
      expect(result.data.provenance).toEqual({ storedThrough: CLOSE, liveFrom: null, liveFailed: false });
    });

    it("reads Kalshi's archive when the market isn't stored", async () => {
      const calls = stubKalshi(TICKER, { archiveCandles: hourly(CLOSE - KALSHI_HISTORY_MS, CLOSE, 0.2) });
      const result = await withStore(() => history(window));
      if (!result.ok) throw new Error(result.error.code);

      expect(paths(calls)).toEqual([`/historical/markets/${TICKER}/candlesticks`]);
      expect(Object.fromEntries(calls[0].searchParams)).toEqual({
        start_ts: String((CLOSE - KALSHI_HISTORY_MS) / 1000),
        end_ts: String(CLOSE / 1000),
        period_interval: "60",
      });
      expect(result.data.points.at(-1)).toMatchObject({ t: CLOSE, source: "midpoint" });
      expect(result.data.points.at(-1)?.value).toBeCloseTo(0.21, 10);
    });
  });
});
