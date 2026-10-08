// The Kalshi collector's reads and writes: markets, candles with the coverage they complete,
// coverage and gaps for every market at once, and a summary of what's stored. Rows are never
// deleted (the collector role can't), and writing a row again changes it only if a value changed
// (db/README.md).

import type { KalshiCandle } from "@/lib/kalshi/candles";
import { recordCoverage, type TimeRange } from "@/lib/store/runs";
import type { KalshiPeriod, KalshiSource } from "@/lib/store/schema";
import type { SessionSql, Sql } from "@/lib/store/sql";
import type { DiscoveredMarket } from "./discover";

const list = (columns: readonly string[], prefix = "") => columns.map((c) => `${prefix}${c}`).join(", ");

// ---- Markets ----

/**
 * A market's row (and its raw copy) is rewritten only when one of these changes. The quotes in
 * `raw` change on every run, so on their own they don't count.
 */
const MARKET_COLUMNS = [
  "event_ticker",
  "series_ticker",
  "title",
  "yes_sub_title",
  "status",
  "result",
  "open_time",
  "close_time",
  "settlement_ts",
  "source",
] as const;

const UPSERT_MARKETS = `
  insert into kalshi_markets as m (ticker, ${list(MARKET_COLUMNS)}, raw)
  select ticker, ${list(MARKET_COLUMNS)}, raw
    from jsonb_to_recordset($1::jsonb) as x(
      ticker text, event_ticker text, series_ticker text, title text, yes_sub_title text, status text,
      result text, open_time timestamptz, close_time timestamptz, settlement_ts timestamptz, source text, raw jsonb)
  on conflict (ticker) do update
    set ${MARKET_COLUMNS.map((c) => `${c} = excluded.${c}`).join(", ")}, raw = excluded.raw, updated_at = now()
    where (${list(MARKET_COLUMNS, "m.")}) is distinct from (${list(MARKET_COLUMNS, "excluded.")})
  returning (xmax = 0) as inserted`;

export interface MarketWrite {
  /** Each market's id, by ticker. */
  ids: Map<string, number>;
  inserted: number;
  updated: number;
}

export async function upsertMarkets(sql: Sql, markets: DiscoveredMarket[]): Promise<MarketWrite> {
  if (!markets.length) return { ids: new Map(), inserted: 0, updated: 0 };
  const iso = (ms: number | null) => (ms === null ? null : new Date(ms).toISOString());
  const rows = markets.map((m) => ({
    ticker: m.ticker,
    event_ticker: m.eventTicker,
    series_ticker: m.seriesTicker,
    title: m.raw.title ?? null,
    yes_sub_title: m.raw.yes_sub_title || null,
    status: m.raw.status ?? "unknown",
    result: m.raw.result || null,
    open_time: iso(m.openTime),
    close_time: iso(m.closeTime),
    settlement_ts: iso(m.settlementTs),
    source: m.source,
    raw: m.raw,
  }));
  const written = await sql.query<{ inserted: boolean }>(UPSERT_MARKETS, [JSON.stringify(rows)]);
  const ids = await sql.query<{ id: number; ticker: string }>("select id, ticker from kalshi_markets where ticker = any($1::text[])", [
    markets.map((m) => m.ticker),
  ]);
  const inserted = written.filter((r) => r.inserted).length;
  return { ids: new Map(ids.map((r) => [r.ticker, r.id])), inserted, updated: written.length - inserted };
}

// ---- Candles ----

/** The candle's values: a rewrite changes a stored candle only if one of these differs. */
const CANDLE_VALUES: readonly [column: string, type: "int" | "bigint", value: (c: KalshiCandle) => number | null][] = [
  ["yes_bid_open", "int", (c) => c.yesBid.open],
  ["yes_bid_high", "int", (c) => c.yesBid.high],
  ["yes_bid_low", "int", (c) => c.yesBid.low],
  ["yes_bid_close", "int", (c) => c.yesBid.close],
  ["yes_ask_open", "int", (c) => c.yesAsk.open],
  ["yes_ask_high", "int", (c) => c.yesAsk.high],
  ["yes_ask_low", "int", (c) => c.yesAsk.low],
  ["yes_ask_close", "int", (c) => c.yesAsk.close],
  ["price_open", "int", (c) => c.price.open],
  ["price_high", "int", (c) => c.price.high],
  ["price_low", "int", (c) => c.price.low],
  ["price_close", "int", (c) => c.price.close],
  ["price_mean", "int", (c) => c.price.mean],
  ["price_previous", "int", (c) => c.price.previous],
  ["volume", "bigint", (c) => c.volume],
  ["open_interest", "bigint", (c) => c.openInterest],
];
const VALUE_COLUMNS = CANDLE_VALUES.map(([column]) => column);

// One statement per window: the candles arrive as one array per column, so a window of thousands
// of candles stays one round trip and far under Postgres's limit on parameters.
const UPSERT_CANDLES = `
  insert into kalshi_candles as c (market_id, period_min, end_ts, ${list(VALUE_COLUMNS)}, source, fetched_at, run_id)
  select $1::int, $2::smallint, t.end_ts, ${list(VALUE_COLUMNS, "t.")}, $3::text, $4::timestamptz, $5::int
    from unnest($6::timestamptz[], ${CANDLE_VALUES.map(([, type], i) => `$${i + 7}::${type}[]`).join(", ")})
      as t(end_ts, ${list(VALUE_COLUMNS)})
  on conflict (market_id, period_min, end_ts) do update
    set ${VALUE_COLUMNS.map((c) => `${c} = excluded.${c}`).join(", ")},
        source = excluded.source, fetched_at = excluded.fetched_at, run_id = excluded.run_id, updated_at = now()
    where (${list(VALUE_COLUMNS, "c.")}) is distinct from (${list(VALUE_COLUMNS, "excluded.")})
  returning (xmax = 0) as inserted`;

export interface CandleWindow {
  runId: number;
  marketId: number;
  ticker: string;
  period: KalshiPeriod;
  /** The endpoint the candles came from. */
  source: KalshiSource;
  /** The range requested: every candle ending in it is in `candles`. */
  range: TimeRange;
  candles: KalshiCandle[];
  /** When Kalshi answered (ms). */
  fetchedAt: number;
}

export interface WindowWrite {
  inserted: number;
  /** Stored candles a value of which changed. */
  changed: number;
}

/**
 * Stores a window's candles and records the range as covered, in one transaction, so coverage
 * never exists without its rows.
 */
export function writeWindow(sql: SessionSql, window: CandleWindow): Promise<WindowWrite> {
  // A repeated end time would make the upsert touch one row twice, which Postgres rejects.
  const candles = [...new Map(window.candles.map((c) => [c.endTs, c])).values()];
  return sql.transaction(async (tx) => {
    let write: WindowWrite = { inserted: 0, changed: 0 };
    if (candles.length) {
      const rows = await tx.query<{ inserted: boolean }>(UPSERT_CANDLES, [
        window.marketId,
        Number(window.period),
        window.source,
        new Date(window.fetchedAt),
        window.runId,
        candles.map((c) => new Date(c.endTs)),
        ...CANDLE_VALUES.map(([, , value]) => candles.map(value)),
      ]);
      const inserted = rows.filter((r) => r.inserted).length;
      write = { inserted, changed: rows.length - inserted };
    }
    await recordCoverage(tx, window.runId, { source: "kalshi", seriesKey: window.ticker, interval: window.period }, window.range, candles.length);
    return write;
  });
}

// ---- Coverage and gaps, for every market at once ----

/** One market's candles of one period. */
export interface SeriesTarget {
  ticker: string;
  period: KalshiPeriod;
  /** Every candle it should have, by end time. */
  range: TimeRange;
}

/** Keys the maps below. */
export const seriesId = (ticker: string, period: string) => `${ticker} ${period}`;

/** Where each Kalshi series' coverage ends (ms), by seriesId: `coveredUntil` (lib/store/runs.ts) for every series in one query. */
export async function coverageEnds(sql: Sql): Promise<Map<string, number>> {
  const rows = await sql.query<{ series_key: string; interval: string; until: Date }>(
    `select series_key, interval, max(upper(covered)) as until
       from fetch_coverage where source = 'kalshi'
      group by series_key, interval`,
  );
  return new Map(rows.map((r) => [seriesId(r.series_key, r.interval), r.until.getTime()]));
}

/**
 * The parts of each target no coverage includes, oldest first, by seriesId; series without gaps
 * are left out. `findGaps` (lib/store/runs.ts) for many series in one query.
 */
export async function findTargetGaps(sql: Sql, targets: SeriesTarget[]): Promise<Map<string, TimeRange[]>> {
  const gaps = new Map<string, TimeRange[]>();
  if (!targets.length) return gaps;
  const rows = await sql.query<{ series_key: string; interval: string; from: Date; to: Date }>(
    `select t.series_key, t.interval, lower(g) as "from", upper(g) as "to"
       from unnest($1::text[], $2::text[], $3::timestamptz[], $4::timestamptz[]) as t(series_key, interval, from_ts, to_ts)
       cross join lateral unnest(
         tstzmultirange(tstzrange(t.from_ts, t.to_ts, '[)'))
         - coalesce(
             (select range_agg(f.covered) from fetch_coverage f
               where f.source = 'kalshi' and f.series_key = t.series_key and f.interval = t.interval),
             '{}'::tstzmultirange)
       ) as g
      order by 1, 2, 3`,
    [
      targets.map((t) => t.ticker),
      targets.map((t) => t.period),
      targets.map((t) => new Date(t.range.from)),
      targets.map((t) => new Date(t.range.to)),
    ],
  );
  for (const r of rows) {
    const id = seriesId(r.series_key, r.interval);
    gaps.set(id, [...(gaps.get(id) ?? []), { from: r.from.getTime(), to: r.to.getTime() }]);
  }
  return gaps;
}

// ---- Runs that never finished ----

/** Longer than any run lasts (the workflow stops at 30 minutes), so a run still `running` this long after it started has died. */
export const ABANDONED_AFTER_MS = 2 * 60 * 60 * 1000;

/**
 * Marks Kalshi runs other than `runId` that died before `finishRun` (a dropped connection, a
 * killed job) as failed, so they don't look in progress forever. Returns their ids. Uses the
 * database's clock, which set started_at.
 */
export async function closeAbandonedRuns(sql: Sql, runId: number): Promise<number[]> {
  const rows = await sql.query<{ id: number }>(
    `update collection_runs
        set status = 'failed', finished_at = now(), error = 'Never finished: the process ended early'
      where collector = 'kalshi' and status = 'running' and id <> $1
        and started_at < now() - make_interval(secs => $2)
      returning id`,
    [runId, ABANDONED_AFTER_MS / 1000],
  );
  return rows.map((r) => r.id).sort((a, b) => a - b);
}

// ---- What's stored ----

export interface StoreSummary {
  markets: number;
  candles: Record<KalshiPeriod, number>;
  /** Kalshi coverage rows. */
  coverage: number;
  /** pg_database_size and each Kalshi table's pg_total_relation_size (with its indexes). */
  bytes: { database: number; markets: number; candles: number; coverage: number };
}

export async function storeSummary(sql: Sql): Promise<StoreSummary> {
  // Counts and sizes are bigint, which the drivers return differently (lib/store/sql.ts): cast to float8.
  const [row] = await sql.query<Record<string, number>>(
    `select (select count(*) from kalshi_markets)::float8 as markets,
            (select count(*) from kalshi_candles where period_min = 60)::float8 as hourly,
            (select count(*) from kalshi_candles where period_min = 1440)::float8 as daily,
            (select count(*) from fetch_coverage where source = 'kalshi')::float8 as coverage,
            pg_database_size(current_database())::float8 as database_bytes,
            pg_total_relation_size('kalshi_markets')::float8 as markets_bytes,
            pg_total_relation_size('kalshi_candles')::float8 as candles_bytes,
            pg_total_relation_size('fetch_coverage')::float8 as coverage_bytes`,
  );
  return {
    markets: row.markets,
    candles: { "60": row.hourly, "1440": row.daily },
    coverage: row.coverage,
    bytes: { database: row.database_bytes, markets: row.markets_bytes, candles: row.candles_bytes, coverage: row.coverage_bytes },
  };
}
