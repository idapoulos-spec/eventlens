// Collection runs and fetch coverage: what each run did, and which time ranges are stored
// completely. Collectors call these; gaps come from coverage, not from missing rows, because
// Kalshi only writes a candle when something changes. Times are milliseconds since the epoch, as
// everywhere in the app.

import type { CoverageInterval, CoverageSource, RunCollector, RunMode, RunStatus, RunTrigger } from "./schema";
import type { Sql } from "./sql";

export interface RunStart {
  collector: RunCollector;
  mode: RunMode;
  trigger: RunTrigger;
}

/** Records a run as started and returns its id, for every row and coverage range it writes. */
export async function startRun(sql: Sql, { collector, mode, trigger }: RunStart): Promise<number> {
  const [row] = await sql.query<{ id: number }>(
    "insert into collection_runs (collector, mode, trigger) values ($1, $2, $3) returning id",
    [collector, mode, trigger],
  );
  return row.id;
}

export interface RunResult {
  status: Exclude<RunStatus, "running">;
  requests: number;
  /** Twelve Data credits; 0 for Kalshi. */
  credits: number;
  rowsInserted: number;
  rowsChanged: number;
  /** Fixed wording only: never an upstream response, a URL, or anything that could hold a secret. */
  error?: string | null;
}

export async function finishRun(sql: Sql, runId: number, result: RunResult): Promise<void> {
  const rows = await sql.query(
    `update collection_runs
        set finished_at = now(), status = $2, requests = $3, credits = $4,
            rows_inserted = $5, rows_changed = $6, error = $7
      where id = $1 and status = 'running'
      returning id`,
    [runId, result.status, result.requests, result.credits, result.rowsInserted, result.rowsChanged, result.error ?? null],
  );
  if (rows.length === 0) throw new Error(`Run ${runId} isn't running.`);
}

/** One series of bars: a Kalshi market's candles of one period, or a stock's bars of one interval. */
export interface SeriesRef {
  source: CoverageSource;
  /** A Kalshi market ticker or a stock symbol. */
  seriesKey: string;
  interval: CoverageInterval;
}

/** A half-open time range [from, to), in milliseconds. */
export interface TimeRange {
  from: number;
  to: number;
}

function checkRange({ from, to }: TimeRange): void {
  if (!Number.isFinite(from) || !Number.isFinite(to) || from >= to) {
    throw new RangeError(`Invalid time range: [${from}, ${to})`);
  }
}

/**
 * Records that every bar of `series` ending in [from, to) was requested and everything returned
 * is stored (`rows` of them). Call it in the same transaction as the rows it covers.
 */
export async function recordCoverage(
  sql: Sql,
  runId: number,
  series: SeriesRef,
  range: TimeRange,
  rows: number,
): Promise<void> {
  checkRange(range);
  await sql.query(
    `insert into fetch_coverage (run_id, source, series_key, interval, covered, rows)
     values ($1, $2, $3, $4, tstzrange($5, $6, '[)'), $7)`,
    [runId, series.source, series.seriesKey, series.interval, new Date(range.from), new Date(range.to), rows],
  );
}

/** The parts of `range` no recorded coverage of `series` includes, oldest first. */
export async function findGaps(sql: Sql, series: SeriesRef, range: TimeRange): Promise<TimeRange[]> {
  checkRange(range);
  const rows = await sql.query<{ from: Date; to: Date }>(
    `select lower(gap) as "from", upper(gap) as "to"
       from unnest(
         tstzmultirange(tstzrange($4, $5, '[)'))
         - coalesce(
             (select range_agg(covered) from fetch_coverage
               where source = $1 and series_key = $2 and interval = $3),
             '{}'::tstzmultirange)
       ) as gap
      order by 1`,
    [series.source, series.seriesKey, series.interval, new Date(range.from), new Date(range.to)],
  );
  return rows.map((r) => ({ from: r.from.getTime(), to: r.to.getTime() }));
}

/** The end of the latest coverage of `series` (ms), or null if it was never fetched. Where an incremental fetch starts. */
export async function coveredUntil(sql: Sql, series: SeriesRef): Promise<number | null> {
  const [row] = await sql.query<{ until: Date | null }>(
    `select max(upper(covered)) as until from fetch_coverage
      where source = $1 and series_key = $2 and interval = $3`,
    [series.source, series.seriesKey, series.interval],
  );
  return row.until ? row.until.getTime() : null;
}
