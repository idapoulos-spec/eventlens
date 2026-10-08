import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RunMode } from "@/lib/store/schema";
import { createTestDb, type TestDb } from "@/lib/store/test-db";
import { collectKalshi, describeError } from "./collect";
import { DAY_MS, fakeKalshi, fakeTime, HOUR_MS, type FakeKalshi, type FakeMarket } from "./test-kalshi";

vi.mock("server-only", () => ({}));

const NOW = Date.UTC(2026, 9, 7, 23, 42);
const LIVE: FakeMarket = {
  ticker: "KXFEDDECISION-26OCT-H0",
  eventTicker: "KXFEDDECISION-26OCT",
  seriesTicker: "KXFEDDECISION",
  source: "live",
  status: "active",
  openTime: Date.UTC(2026, 8, 1, 14),
  closeTime: Date.UTC(2026, 9, 28, 17, 59),
};
const ARCHIVED: FakeMarket = {
  ticker: "KXFEDDECISION-26JUL-H0",
  eventTicker: "KXFEDDECISION-26JUL",
  seriesTicker: "KXFEDDECISION",
  source: "historical",
  status: "finalized",
  openTime: Date.UTC(2026, 5, 1, 14),
  closeTime: Date.UTC(2026, 6, 29, 17, 59),
  settlementTs: Date.UTC(2026, 6, 29, 18, 7, 36),
};

let db: TestDb;
let kalshi: FakeKalshi;
let logs: string[];

beforeEach(async () => {
  db = await createTestDb();
  kalshi = fakeKalshi([LIVE, ARCHIVED], NOW);
  logs = [];
});
afterEach(async () => {
  vi.unstubAllGlobals();
  await db.close();
});

/** One run as the collector role, with Kalshi's clock at `now`. The watchlist is the seeded one: KXFEDDECISION, 60 and 1440. */
function run(mode: RunMode, now = NOW) {
  kalshi.now = now;
  const t = fakeTime(now);
  return db.asRole("eventlens_collector", (sql) =>
    collectKalshi({ sql, mode, trigger: "local", now, sleep: t.sleep, clock: t.clock, log: (line) => logs.push(line) }),
  );
}

interface CandleSpan {
  ticker: string;
  period_min: number;
  n: number;
  first: Date;
  last: Date;
  sources: string[];
}

const spans = () =>
  db.sql.query<CandleSpan>(
    `select m.ticker, c.period_min, count(*)::int as n, min(c.end_ts) as first, max(c.end_ts) as last,
            array_agg(distinct c.source) as sources
       from kalshi_candles c join kalshi_markets m on m.id = c.market_id
      group by 1, 2 order by 1, 2`,
  );

const runs = () =>
  db.sql.query("select mode, status, requests, credits, rows_inserted, rows_changed, error from collection_runs order by id");

const candleRequests = () => kalshi.requests.filter((u) => u.pathname.endsWith("/candlesticks"));

describe("backfill", () => {
  it("stores every market's whole history from both endpoints, with no gaps", async () => {
    const summary = await run("backfill");
    expect(summary).toMatchObject({ status: "ok", gapSeries: 0, windows: { fetched: 4, failed: 0 }, rowsChanged: 0, error: null });

    const stored = await spans();
    expect(stored.map(({ ticker, period_min, first, last, sources }) => [ticker, period_min, first, last, sources])).toEqual([
      // The archive's market runs through the hour after it settled; the live one to the last hour that ended.
      ["KXFEDDECISION-26JUL-H0", 60, new Date(ARCHIVED.openTime), new Date(Date.UTC(2026, 6, 29, 19)), ["historical"]],
      ["KXFEDDECISION-26JUL-H0", 1440, new Date(Date.UTC(2026, 5, 2, 4)), new Date(Date.UTC(2026, 6, 30, 4)), ["historical"]],
      ["KXFEDDECISION-26OCT-H0", 60, new Date(LIVE.openTime), new Date(Date.UTC(2026, 9, 7, 23)), ["live"]],
      ["KXFEDDECISION-26OCT-H0", 1440, new Date(Date.UTC(2026, 8, 2, 4)), new Date(Date.UTC(2026, 9, 7, 4)), ["live"]],
    ]);
    // A candle for every period in between: nothing was skipped.
    for (const s of stored) {
      expect(s.n).toBe((s.last.getTime() - s.first.getTime()) / (s.period_min * 60_000) + 1);
    }
    const total = stored.reduce((sum, s) => sum + s.n, 0);
    expect(summary.rowsInserted).toBe(total);
    expect(summary.store).toMatchObject({ markets: 2, coverage: 4 });
    const candles = summary.store?.candles;
    expect(candles && candles["60"] + candles["1440"]).toBe(total);

    // 2 market lists + 4 candle windows.
    expect(await runs()).toEqual([
      { mode: "backfill", status: "ok", requests: 6, credits: 0, rows_inserted: total, rows_changed: 0, error: null },
    ]);
  });

  it("fetches everything again on a second backfill, changing nothing", async () => {
    await run("backfill");
    const again = await run("backfill");
    expect(again).toMatchObject({ status: "ok", rowsInserted: 0, rowsChanged: 0, windows: { fetched: 4 } });
  });
});

describe("incremental", () => {
  it("fetches only what's new, so a second run right after inserts nothing", async () => {
    await run("backfill");
    kalshi.requests = [];

    const first = await run("incremental", NOW + 3 * HOUR_MS);
    // Three more hourly candles for the live market (00:00 to 02:00); its next daily candle ends at 04:00.
    expect(first).toMatchObject({ status: "ok", rowsInserted: 3, rowsChanged: 0, gapSeries: 0 });
    // The settled market is covered through its end, so it isn't asked for again.
    expect(candleRequests().map((u) => u.searchParams.get("market_tickers"))).toEqual([LIVE.ticker, LIVE.ticker]);
    // Each starts two periods before what the backfill covered (23:37).
    const hourly = candleRequests().find((u) => u.searchParams.get("period_interval") === "60")!;
    expect(Number(hourly.searchParams.get("start_ts")) * 1000).toBe(Date.UTC(2026, 9, 7, 21, 37));

    const second = await run("incremental", NOW + 3 * HOUR_MS + 60_000);
    expect(second).toMatchObject({ status: "ok", rowsInserted: 0, rowsChanged: 0, gapSeries: 0 });
    expect((await runs()).map((r) => [r.mode, r.status, r.rows_inserted])).toEqual([
      ["backfill", "ok", expect.any(Number)],
      ["incremental", "ok", 3],
      ["incremental", "ok", 0],
    ]);
  });

  it("picks up a late correction within its overlap as a changed row", async () => {
    await run("backfill");
    const corrected = Date.UTC(2026, 9, 7, 23);
    kalshi.price = (ticker, period, endTs) => (ticker === LIVE.ticker && period === 60 && endTs === corrected ? "0.4700" : "0.4500");
    expect(await run("incremental", NOW + 10 * 60_000)).toMatchObject({ rowsInserted: 0, rowsChanged: 1 });
    const [row] = await db.sql.query("select yes_bid_close, updated_at is not null as updated from kalshi_candles where end_ts = $1 and period_min = 60", [
      new Date(corrected),
    ]);
    expect(row).toEqual({ yes_bid_close: 470000, updated: true });
  });

  it("collects a newly listed market's whole history", async () => {
    await run("backfill");
    kalshi.markets.push({ ...LIVE, ticker: "KXFEDDECISION-26OCT-H25" });
    const summary = await run("incremental", NOW + 10 * 60_000);
    expect(summary.status).toBe("ok");
    const added = (await spans()).filter((s) => s.ticker === "KXFEDDECISION-26OCT-H25");
    expect(added.map((s) => [s.period_min, s.first])).toEqual([
      [60, new Date(LIVE.openTime)],
      [1440, new Date(Date.UTC(2026, 8, 2, 4))],
    ]);
  });
});

describe("failures and gap repair", () => {
  it("marks the run partial when a window fails, and a repair run fills the gap", async () => {
    kalshi.failWith = (url) => (url.searchParams.get("market_tickers") === LIVE.ticker && url.searchParams.get("period_interval") === "60" ? 500 : undefined);
    const failed = await run("backfill");
    expect(failed).toMatchObject({ status: "partial", gapSeries: 1, windows: { fetched: 3, failed: 1 }, error: "1 window failed; 1 series with gaps" });
    expect(logs).toContain(`${LIVE.ticker} 60-min window failed: unavailable`);
    expect(logs).toContain(`gaps: 1 series in ${LIVE.ticker}`);
    // The failed window was tried twice (one retry) and left no coverage.
    expect((await runs())[0]).toMatchObject({ status: "partial", requests: 7 });

    kalshi.failWith = () => undefined;
    kalshi.requests = [];
    const repaired = await run("repair");
    expect(repaired).toMatchObject({ status: "ok", gapSeries: 0, windows: { fetched: 1, failed: 0 } });
    expect(candleRequests()).toHaveLength(1);
    expect((await spans()).find((s) => s.ticker === LIVE.ticker && s.period_min === 60)?.first).toEqual(new Date(LIVE.openTime));
  });

  it("repairs a gap inside covered history on an incremental run", async () => {
    // Over 400 days, so its hourly history takes two windows; the first fails.
    const long: FakeMarket = { ...ARCHIVED, ticker: "FEDDECISION-23JUL-H0", openTime: Date.UTC(2023, 0, 2, 14), closeTime: Date.UTC(2024, 6, 31, 17, 55), settlementTs: undefined };
    kalshi.markets = [long];
    kalshi.failWith = (url) => (url.searchParams.get("period_interval") === "60" && Number(url.searchParams.get("start_ts")) * 1000 === long.openTime ? 500 : undefined);
    expect(await run("backfill")).toMatchObject({ status: "partial", gapSeries: 1 });

    kalshi.failWith = () => undefined;
    kalshi.requests = [];
    const summary = await run("incremental", NOW + 60_000);
    expect(summary).toMatchObject({ status: "ok", gapSeries: 0, windows: { fetched: 1 } });
    expect(logs).toContain("repairing 1 of 1 gap window");
    expect(Number(candleRequests()[0].searchParams.get("start_ts")) * 1000).toBe(long.openTime);
  });

  it("follows a market Kalshi moves to its archive during the run", async () => {
    kalshi.failWith = (url) => {
      if (url.pathname.endsWith("/markets/candlesticks")) kalshi.archive(LIVE.ticker);
      return undefined;
    };
    const summary = await run("backfill");
    expect(summary).toMatchObject({ status: "ok", gapSeries: 0 });
    const live = (await spans()).filter((s) => s.ticker === LIVE.ticker);
    expect(live.map((s) => s.sources)).toEqual([["historical"], ["historical"]]);
    // The first window asked the live endpoint, then the archive; the second went straight to the archive.
    expect(candleRequests().filter((u) => u.searchParams.get("market_tickers") === LIVE.ticker)).toHaveLength(1);
  });

  it("fails without fetching candles when markets can't be listed", async () => {
    kalshi.failWith = (url) => (url.pathname.endsWith("/historical/markets") ? 503 : undefined);
    const summary = await run("incremental");
    expect(summary).toMatchObject({ status: "failed", error: "Market discovery failed: unavailable", rowsInserted: 0, store: null });
    expect(candleRequests()).toEqual([]);
    expect((await runs())[0]).toMatchObject({ status: "failed", error: "Market discovery failed: unavailable" });
  });

  it("records an unexpected error by name and code only", async () => {
    await db.sql.exec("revoke insert on kalshi_candles from eventlens_collector");
    const summary = await run("backfill");
    expect(summary).toMatchObject({ status: "failed", error: "Unexpected error: error, Postgres 42501" });
    expect((await runs())[0]).toMatchObject({ status: "failed", error: "Unexpected error: error, Postgres 42501" });
  });
});

describe("logs", () => {
  it("hold counts, tickers, and codes, never prices or URLs", async () => {
    kalshi.failWith = (url) => (url.searchParams.get("period_interval") === "1440" && url.pathname.includes("/historical/") ? 429 : undefined);
    await run("backfill");
    await run("incremental", NOW + DAY_MS);
    expect(logs.length).toBeGreaterThan(5);
    for (const line of logs) {
      expect(line).not.toMatch(/:\/\/|0\.45|450000|kalshi\.com/);
    }
    expect(logs).toContain(`${ARCHIVED.ticker} 1440-min window failed: rate_limited`);
  });

  it("describe errors without their message", () => {
    const err = Object.assign(new Error('new row violates check constraint: Failing row contains (450000, "secret")'), {
      code: "23514",
      constraint: "micro_dollars_check",
    });
    expect(describeError(err)).toBe("Error, Postgres 23514, constraint micro_dollars_check");
    expect(describeError("weird")).toBe("Error");
  });
});
