// Every upstream request a whole-event analysis makes, and what it computes from them: live without
// the store, store first with it, and Kalshi's archive for an event settled before its cutoff. The
// Twelve Data side is the same 5 credits as a single-market analysis.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { seedCandles, seedCoverage, seedMarket, seedRun } from "@/lib/history/test-fixtures";
import { createTestDb, type TestDb } from "@/lib/store/test-db";
import type { loadEventAnalysis as LoadEventAnalysis } from "./load";
import { DAY_MS, fedMarkets, HOUR_MS, OUTCOMES, stubUpstreams } from "./test-fixtures";

vi.mock("server-only", () => ({}));
const appSql = vi.hoisted(() => vi.fn());
vi.mock("@/lib/store/db", () => ({ getAppSql: appSql }));

const NOW = Date.UTC(2026, 9, 7, 16, 40, 30);
const END = Date.UTC(2026, 9, 7, 16, 40);
const OPEN_EVENT = "KXFEDDECISION-26OCT";
const SETTLED_EVENT = "KXFEDDECISION-25DEC";
const SETTLED_CLOSE = Date.UTC(2025, 11, 10, 19);
// E from the fixture's books: (−50·0.005 − 25·0.1 + 25·0.05 + 50·0.005) / 0.96.
const E = (-50 * 0.005 - 25 * 0.1 + 25 * 0.05 + 50 * 0.005) / 0.96;

/** Every 6 hours from `from` through `to`. */
const every6h = (from: number, to: number) => Array.from({ length: Math.floor((to - from) / (6 * HOUR_MS)) + 1 }, (_, i) => from + i * 6 * HOUR_MS);
const tickers = (event: string, suffixes = OUTCOMES.map(([s]) => s)) => suffixes.map((s) => `${event}-${s}`).join(",");

let db: TestDb;
let loadEventAnalysis: typeof LoadEventAnalysis;

beforeEach(async () => {
  vi.stubEnv("TWELVE_DATA_API_KEY", "test-key");
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  vi.resetModules();
  ({ loadEventAnalysis } = await import("./load"));
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

async function run(stock: string, event: string) {
  const { event: e, stockData, benchmarkData } = loadEventAnalysis(stock, event);
  return Promise.all([e, stockData, benchmarkData]);
}

/** Runs the analysis with the store on, as the app's role. */
const withStore = (stock: string, event: string) =>
  db.asRole("eventlens_app", (sql) => {
    appSql.mockReturnValue(sql);
    return run(stock, event);
  });

const twelveData = (requests: string[]) => requests.filter((r) => r.startsWith("twelvedata"));

/** Stores an event's outcomes, a candle every 6 hours from their open, and coverage through `coveredTo`. */
async function storeEvent(event: string, { status, open, close, coveredTo }: { status: string; open: number; close: number; coveredTo: number }) {
  const run = await seedRun(db.sql);
  for (const raw of fedMarkets(event, { status, open, close })) {
    const id = await seedMarket(db.sql, { ticker: raw.ticker, status, openTime: open, closeTime: close, raw });
    const [, , , bid, ask] = OUTCOMES.find(([s]) => raw.ticker.endsWith(`-${s}`))!;
    await seedCandles(
      db.sql,
      run,
      id,
      every6h(open, Math.min(close, coveredTo - 1)).map((t) => ({ t, bid: bid || undefined, ask })),
    );
    await seedCoverage(db.sql, run, "kalshi", raw.ticker, "60", open, coveredTo);
  }
}

describe("loadEventAnalysis", () => {
  it("without the store, reads the event and its outcomes' 97 days live, in as few batches as Kalshi allows", async () => {
    const open = END - 120 * DAY_MS;
    const requests = stubUpstreams({
      ticker: OPEN_EVENT,
      live: fedMarkets(OPEN_EVENT, { status: "active", open, close: Date.UTC(2026, 9, 28, 18) }),
      candleTimes: every6h(END - 97 * DAY_MS, END),
    });
    const [event, stock] = await run("TLT", OPEN_EVENT);
    const start = (END - 97 * DAY_MS) / 1000;
    expect(requests.sort()).toEqual(
      [
        `kalshi /events/${OPEN_EVENT}`,
        // 2,328 hourly candles each: four markets fit under Kalshi's 10,000 a request.
        `kalshi /markets/candlesticks market_tickers=${tickers(OPEN_EVENT, ["C26", "C25", "H0", "H25"])} start_ts=${start} end_ts=${END / 1000} period_interval=60`,
        `kalshi /markets/candlesticks market_tickers=${tickers(OPEN_EVENT, ["H26"])} start_ts=${start} end_ts=${END / 1000} period_interval=60`,
        "twelvedata /quote symbol=TLT",
        "twelvedata /time_series symbol=TLT interval=30min outputsize=900",
        "twelvedata /time_series symbol=TLT interval=1day outputsize=90",
        "twelvedata /time_series symbol=SPY interval=30min outputsize=900",
        "twelvedata /time_series symbol=SPY interval=1day outputsize=90",
      ].sort(),
    );
    expect(stock.ok && stock.data.research.end).toBeNull();
    if (!event.ok) throw new Error("expected an event");
    const e = event.data;
    expect(e.phase).toBe("open");
    expect(e.current).toMatchObject({ missing: null, openSet: tickers(OPEN_EVENT).split(",").sort() });
    expect(e.current!.value).toBeCloseTo(E, 12);
    expect(e.current!.sumP).toBeCloseTo(0.96, 12);
    expect(e.change1h).toMatchObject({ value: 0, unavailable: null });
    // Every top of the hour in the 90 days before 16:40.
    expect(e.marks).toHaveLength(90 * 24);
    expect(e.marks.every((m) => m.missing === null)).toBe(true);
    expect(e.provenance).toEqual({ storedThrough: null, liveFrom: END - 97 * DAY_MS, liveFailed: false });
    // Each outcome's row: its value, how it was read, and its live probability.
    expect(e.outcomes.map((o) => [o.value, o.mappedBy, o.rule])).toEqual([
      [-50, "strike_and_label", 2],
      [-25, "strike_and_label", 1],
      [0, "strike_and_label", 1],
      [25, "strike_and_label", 1],
      [50, "strike_and_label", 2],
    ]);
  });

  it("with the store, reads a settled event from it alone, ending at its close, for the usual 5 credits", async () => {
    const open = SETTLED_CLOSE - 120 * DAY_MS;
    await storeEvent(SETTLED_EVENT, { status: "finalized", open, close: SETTLED_CLOSE, coveredTo: SETTLED_CLOSE + HOUR_MS });
    const requests = stubUpstreams({ ticker: SETTLED_EVENT, live: [], candleTimes: [] });
    const [event, stock] = await withStore("TLT", SETTLED_EVENT);

    expect(requests.filter((r) => r.startsWith("kalshi"))).toEqual([`kalshi /events/${SETTLED_EVENT}`]);
    expect(twelveData(requests)).toHaveLength(5);
    expect(twelveData(requests).filter((r) => r.includes("end_date=2025-12-11"))).toHaveLength(3);
    expect(stock.ok && stock.data.research.end).toBe(SETTLED_CLOSE);
    if (!event.ok) throw new Error("expected an event");
    const e = event.data;
    expect(e).toMatchObject({ phase: "settled", decided: { ticker: `${SETTLED_EVENT}-H0` }, window: { end: SETTLED_CLOSE, archived: true } });
    expect(e.provenance).toEqual({ storedThrough: SETTLED_CLOSE, liveFrom: null, liveFailed: false });
    // The last value before the close, from the stored books.
    expect(e.current!.t).toBe(SETTLED_CLOSE - HOUR_MS);
    expect(e.current!.value).toBeCloseTo(E, 12);
    expect(e.marks.at(-1)).toMatchObject({ t: SETTLED_CLOSE, missing: "after_close" });
  });

  it("with the store, fetches only an open event's tail after what's stored, overlapping it by 2 hours", async () => {
    const open = END - 120 * DAY_MS;
    const coveredTo = Date.UTC(2026, 9, 7, 13);
    await storeEvent(OPEN_EVENT, { status: "active", open, close: Date.UTC(2026, 9, 28, 18), coveredTo });
    const requests = stubUpstreams({
      ticker: OPEN_EVENT,
      live: fedMarkets(OPEN_EVENT, { status: "active", open, close: Date.UTC(2026, 9, 28, 18) }),
      candleTimes: [Date.UTC(2026, 9, 7, 14)],
    });
    const [event] = await withStore("TLT", OPEN_EVENT);

    expect(requests.filter((r) => r.startsWith("kalshi")).sort()).toEqual(
      [
        `kalshi /events/${OPEN_EVENT}`,
        `kalshi /markets/candlesticks market_tickers=${tickers(OPEN_EVENT)} start_ts=${(coveredTo - 2 * HOUR_MS) / 1000} end_ts=${END / 1000} period_interval=60`,
      ].sort(),
    );
    expect(twelveData(requests)).toHaveLength(5);
    if (!event.ok) throw new Error("expected an event");
    expect(event.data.provenance).toEqual({ storedThrough: coveredTo, liveFrom: coveredTo - 2 * HOUR_MS, liveFailed: false });
    expect(event.data.marks.every((m) => m.missing === null)).toBe(true);
  });

  it("with the store, reads an archived event that isn't stored from Kalshi's archive", async () => {
    const open = SETTLED_CLOSE - 120 * DAY_MS;
    const archive = fedMarkets(SETTLED_EVENT, { status: "finalized", open, close: SETTLED_CLOSE });
    const requests = stubUpstreams({ ticker: SETTLED_EVENT, live: [], archive, candleTimes: every6h(open, SETTLED_CLOSE) });
    const [event] = await withStore("TLT", SETTLED_EVENT);

    const start = (SETTLED_CLOSE - 97 * DAY_MS) / 1000;
    expect(requests.filter((r) => r.startsWith("kalshi")).sort()).toEqual(
      [
        `kalshi /events/${SETTLED_EVENT}`,
        `kalshi /historical/markets event_ticker=${SETTLED_EVENT}`,
        ...archive.map((m) => `kalshi /historical/markets/${m.ticker}/candlesticks start_ts=${start} end_ts=${SETTLED_CLOSE / 1000} period_interval=60`),
      ].sort(),
    );
    expect(twelveData(requests)).toHaveLength(5);
    if (!event.ok) throw new Error("expected an event");
    // Live history starts after the outcomes opened, so what came before is unknown; every outcome
    // has a usable quote in it, so no mark needs it.
    expect(event.data.marks.filter((m) => m.missing !== null && m.missing !== "after_close")).toEqual([]);
    expect(event.data.current!.value).toBeCloseTo(E, 12);
  });

  it("says so for an event Kalshi doesn't know, and for a ticker that isn't a supported event", async () => {
    stubUpstreams({ ticker: "KXFEDDECISION-99JAN", live: [], candleTimes: [] });
    const [event] = await run("TLT", OPEN_EVENT);
    expect(event).toMatchObject({ ok: false, error: { code: "not_found" } });
    const [unsupported] = await run("TLT", "KXFED-26DEC");
    expect(unsupported).toMatchObject({ ok: false, error: { code: "unsupported" } });
  });
});
