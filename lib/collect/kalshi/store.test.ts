import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { KalshiCandle } from "@/lib/kalshi/candles";
import { findGaps, recordCoverage, startRun } from "@/lib/store/runs";
import type { SessionSql } from "@/lib/store/sql";
import { createTestDb, type TestDb } from "@/lib/store/test-db";
import type { DiscoveredMarket } from "./discover";
import { coverageEnds, findTargetGaps, seriesId, storeSummary, upsertMarkets, writeWindow, type CandleWindow } from "./store";

const HOUR = 60 * 60 * 1000;
const T0 = Date.UTC(2026, 9, 1);
const at = (hours: number) => T0 + hours * HOUR;

function market(ticker: string, overrides: Partial<DiscoveredMarket> = {}): DiscoveredMarket {
  return {
    ticker,
    eventTicker: "KXFEDDECISION-26OCT",
    seriesTicker: "KXFEDDECISION",
    source: "live",
    periods: ["60", "1440"],
    openTime: at(0),
    closeTime: at(600),
    settlementTs: null,
    raw: { ticker, event_ticker: "KXFEDDECISION-26OCT", title: "Fed decision", yes_sub_title: "Hike 0bps", status: "active", result: "" },
    ...overrides,
  };
}

function candle(hours: number, yesBidClose: number | null = 450000): KalshiCandle {
  const none = { open: null, high: null, low: null, close: null };
  return {
    endTs: at(hours),
    yesBid: { ...none, close: yesBidClose },
    yesAsk: { open: 460000, high: 470000, low: 455000, close: 465000 },
    price: { ...none, mean: null, previous: 440000 },
    volume: 123_456_789_00,
    openInterest: null,
  };
}

let db: TestDb;
beforeEach(async () => {
  db = await createTestDb();
});
afterEach(() => db.close());

/** Runs `fn` as the collector role, as the collector's connection does on Neon. */
const asCollector = <T>(fn: (sql: SessionSql) => Promise<T>) => db.asRole("eventlens_collector", fn);

describe("upsertMarkets", () => {
  it("inserts new markets, then rewrites one only when a column changes", async () => {
    const markets = [market("KXFEDDECISION-26OCT-H0"), market("KXFEDDECISION-26OCT-H25")];
    const first = await asCollector((sql) => upsertMarkets(sql, markets));
    expect([first.inserted, first.updated, [...first.ids.keys()].sort()]).toEqual([2, 0, ["KXFEDDECISION-26OCT-H0", "KXFEDDECISION-26OCT-H25"]]);

    // New quotes alone don't rewrite the row.
    markets[0].raw = { ...markets[0].raw, yes_bid_dollars: "0.5100" };
    expect(await asCollector((sql) => upsertMarkets(sql, markets))).toMatchObject({ inserted: 0, updated: 0 });

    // Moving to the archive does, raw copy included.
    markets[0] = market("KXFEDDECISION-26OCT-H0", {
      source: "historical",
      settlementTs: at(601),
      raw: { ...markets[0].raw, status: "finalized", result: "no", settlement_ts: new Date(at(601)).toISOString() },
    });
    const third = await asCollector((sql) => upsertMarkets(sql, markets));
    expect(third).toMatchObject({ inserted: 0, updated: 1 });
    expect(third.ids).toEqual(first.ids);

    const [row] = await db.sql.query(
      `select source, status, result, settlement_ts, raw->>'status' as raw_status, updated_at > first_seen_at as updated, title, yes_sub_title
         from kalshi_markets where ticker = 'KXFEDDECISION-26OCT-H0'`,
    );
    expect(row).toEqual({
      source: "historical",
      status: "finalized",
      result: "no",
      settlement_ts: new Date(at(601)),
      raw_status: "finalized",
      updated: true,
      title: "Fed decision",
      yes_sub_title: "Hike 0bps",
    });
  });
});

describe("writeWindow", () => {
  let runId: number;
  let marketId: number;
  const TICKER = "KXFEDDECISION-26OCT-H0";

  beforeEach(async () => {
    runId = await startRun(db.sql, { collector: "kalshi", mode: "backfill", trigger: "local" });
    marketId = (await upsertMarkets(db.sql, [market(TICKER)])).ids.get(TICKER)!;
  });

  const window = (candles: KalshiCandle[], overrides: Partial<CandleWindow> = {}): CandleWindow => ({
    runId,
    marketId,
    ticker: TICKER,
    period: "60",
    source: "live",
    range: { from: at(0), to: at(3) },
    candles,
    fetchedAt: at(4),
    ...overrides,
  });

  it("stores candles exactly, nulls included, with their coverage", async () => {
    expect(await asCollector((sql) => writeWindow(sql, window([candle(1), candle(2, null)])))).toEqual({ inserted: 2, changed: 0 });
    const rows = await db.sql.query(
      `select end_ts, yes_bid_close, yes_bid_open, yes_ask_high, price_previous, volume::float8 as volume, open_interest, source, fetched_at, updated_at
         from kalshi_candles order by end_ts`,
    );
    expect(rows[0]).toEqual({
      end_ts: new Date(at(1)),
      yes_bid_close: 450000,
      yes_bid_open: null,
      yes_ask_high: 470000,
      price_previous: 440000,
      volume: 123_456_789_00,
      open_interest: null,
      source: "live",
      fetched_at: new Date(at(4)),
      updated_at: null,
    });
    expect(rows[1]).toMatchObject({ yes_bid_close: null });
    const coverage = await db.sql.query("select series_key, interval, rows, lower(covered) as from, upper(covered) as to from fetch_coverage");
    expect(coverage).toEqual([{ series_key: TICKER, interval: "60", rows: 2, from: new Date(at(0)), to: new Date(at(3)) }]);
  });

  it("changes nothing when the same window is written again, and counts a real change", async () => {
    await asCollector((sql) => writeWindow(sql, window([candle(1), candle(2)])));
    expect(await asCollector((sql) => writeWindow(sql, window([candle(1), candle(2)], { fetchedAt: at(5) })))).toEqual({
      inserted: 0,
      changed: 0,
    });
    const [unchanged] = await db.sql.query("select fetched_at, updated_at from kalshi_candles where end_ts = $1", [new Date(at(2))]);
    expect(unchanged).toEqual({ fetched_at: new Date(at(4)), updated_at: null });

    const run2 = await startRun(db.sql, { collector: "kalshi", mode: "incremental", trigger: "local" });
    const write = await asCollector((sql) =>
      writeWindow(sql, window([candle(1), candle(2, 470000), candle(3)], { runId: run2, source: "historical", fetchedAt: at(6), range: { from: at(1), to: at(4) } })),
    );
    expect(write).toEqual({ inserted: 1, changed: 1 });
    const [changed] = await db.sql.query("select yes_bid_close, source, fetched_at, run_id, updated_at is not null as updated from kalshi_candles where end_ts = $1", [
      new Date(at(2)),
    ]);
    expect(changed).toEqual({ yes_bid_close: 470000, source: "historical", fetched_at: new Date(at(6)), run_id: run2, updated: true });
  });

  it("records coverage for a window without candles", async () => {
    expect(await asCollector((sql) => writeWindow(sql, window([])))).toEqual({ inserted: 0, changed: 0 });
    expect(await findGaps(db.sql, { source: "kalshi", seriesKey: TICKER, interval: "60" }, { from: at(0), to: at(3) })).toEqual([]);
  });

  it("stores neither candles nor coverage when the write fails", async () => {
    await expect(asCollector((sql) => writeWindow(sql, window([candle(1), candle(2, 2_000_000)])))).rejects.toThrow(/micro_dollars/);
    const [counts] = await db.sql.query<{ candles: number; coverage: number }>(
      "select (select count(*)::int from kalshi_candles) as candles, (select count(*)::int from fetch_coverage) as coverage",
    );
    expect(counts).toEqual({ candles: 0, coverage: 0 });
  });

  it("keeps one candle when Kalshi repeats an end time", async () => {
    expect(await asCollector((sql) => writeWindow(sql, window([candle(1), candle(1, 460000)])))).toEqual({ inserted: 1, changed: 0 });
    const [row] = await db.sql.query("select yes_bid_close from kalshi_candles");
    expect(row).toEqual({ yes_bid_close: 460000 });
  });
});

describe("coverage and gaps for many series", () => {
  it("agrees with coveredUntil and findGaps, one query for all", async () => {
    const runId = await startRun(db.sql, { collector: "kalshi", mode: "backfill", trigger: "local" });
    const cover = (seriesKey: string, interval: "60" | "1440", from: number, to: number) =>
      recordCoverage(db.sql, runId, { source: "kalshi", seriesKey, interval }, { from: at(from), to: at(to) }, 0);
    await cover("A", "60", 0, 6);
    await cover("A", "60", 4, 10);
    await cover("A", "60", 15, 20);
    await cover("A", "1440", 0, 24);
    await cover("B", "60", 2, 30);
    await recordCoverage(db.sql, runId, { source: "twelve_data", seriesKey: "C", interval: "30min" }, { from: at(0), to: at(1) }, 0);

    const ends = await asCollector((sql) => coverageEnds(sql));
    expect(ends).toEqual(new Map([[seriesId("A", "60"), at(20)], [seriesId("A", "1440"), at(24)], [seriesId("B", "60"), at(30)]]));

    const targets = [
      { ticker: "A", period: "60", range: { from: at(0), to: at(24) } },
      { ticker: "A", period: "1440", range: { from: at(0), to: at(24) } },
      { ticker: "B", period: "60", range: { from: at(0), to: at(24) } },
      { ticker: "C", period: "60", range: { from: at(0), to: at(2) } },
    ] as const;
    const gaps = await asCollector((sql) => findTargetGaps(sql, [...targets]));
    for (const t of targets) {
      const one = await findGaps(db.sql, { source: "kalshi", seriesKey: t.ticker, interval: t.period }, t.range);
      expect(gaps.get(seriesId(t.ticker, t.period)) ?? []).toEqual(one);
    }
    expect(gaps.get(seriesId("A", "60"))).toEqual([
      { from: at(10), to: at(15) },
      { from: at(20), to: at(24) },
    ]);
    expect(gaps.has(seriesId("A", "1440"))).toBe(false);
  });
});

describe("storeSummary", () => {
  it("counts what's stored and how big it is", async () => {
    const runId = await startRun(db.sql, { collector: "kalshi", mode: "backfill", trigger: "local" });
    const marketId = (await upsertMarkets(db.sql, [market("KXFEDDECISION-26OCT-H0")])).ids.get("KXFEDDECISION-26OCT-H0")!;
    const base = { runId, marketId, ticker: "KXFEDDECISION-26OCT-H0", source: "live", fetchedAt: at(30) } as const;
    await writeWindow(db.sql, { ...base, period: "60", range: { from: at(0), to: at(3) }, candles: [candle(1), candle(2)] });
    await writeWindow(db.sql, { ...base, period: "1440", range: { from: at(0), to: at(24) }, candles: [candle(4)] });

    const summary = await asCollector((sql) => storeSummary(sql));
    expect(summary).toMatchObject({ markets: 1, candles: { "60": 2, "1440": 1 }, coverage: 2 });
    expect(summary.bytes.database).toBeGreaterThan(summary.bytes.candles);
    expect(summary.bytes.candles).toBeGreaterThan(0);
  });
});
