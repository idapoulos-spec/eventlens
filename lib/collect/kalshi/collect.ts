// One Kalshi collection run: find the watchlist's markets, fetch their candles, store them with
// the coverage they complete, repair gaps, and record the run in collection_runs.
//
// - incremental (scheduled): each market from shortly before the end of its coverage (from its
//   open if it was never fetched) up to now, skipping markets covered through their end, then up
//   to REPAIR_CAP gap windows.
// - backfill: every market's whole history, covered or not. Rows change only where Kalshi's values did.
// - repair: every gap, and nothing else.
//
// Every mode ends by checking gaps over every market's whole history. The run is `ok` only if no
// window failed and nothing is missing. Logs are public in GitHub Actions: they hold counts,
// tickers, and fixed codes only, never prices, rows, URLs, or an error's message.

import { readWatchlist } from "@/lib/store/watchlist";
import { finishRun, startRun, type RunResult, type TimeRange } from "@/lib/store/runs";
import type { KalshiPeriod, KalshiSource, RunMode, RunTrigger } from "@/lib/store/schema";
import type { SessionSql } from "@/lib/store/sql";
import { createKalshiApi, type KalshiApiOptions } from "./api";
import { discoverMarkets, type DiscoveredMarket } from "./discover";
import { incrementalRange, splitWindows, targetRange } from "./ranges";
import {
  closeAbandonedRuns,
  coverageEnds,
  findTargetGaps,
  seriesId,
  storeSummary,
  upsertMarkets,
  writeWindow,
  type SeriesTarget,
  type StoreSummary,
} from "./store";

/** Gap windows an incremental run repairs at most; a repair run has no cap. */
export const REPAIR_CAP = 25;
/** Tickers listed by name in a log line before "and N more". */
const LOGGED_TICKERS = 10;

export interface CollectOptions extends KalshiApiOptions {
  sql: SessionSql;
  mode: RunMode;
  trigger: RunTrigger;
  /** The run's reference time (ms): candles must have ended SETTLE_MS before it. */
  now?: number;
  log?: (line: string) => void;
}

export interface CollectSummary {
  runId: number;
  status: RunResult["status"];
  requests: number;
  rowsInserted: number;
  rowsChanged: number;
  windows: { fetched: number; failed: number };
  /** Series (market and period) with time no coverage includes, after the run. */
  gapSeries: number;
  error: string | null;
  /** What's stored after the run; null if the run failed before it could be read. */
  store: StoreSummary | null;
}

interface Series extends SeriesTarget {
  market: DiscoveredMarket;
  marketId: number;
}

const tickers = (names: string[]) =>
  names.length > LOGGED_TICKERS ? `${names.slice(0, LOGGED_TICKERS).join(", ")} and ${names.length - LOGGED_TICKERS} more` : names.join(", ");

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** An unexpected error's name and Postgres code and constraint, never its message: Postgres quotes failing rows. */
export function describeError(err: unknown): string {
  const { name, code, constraint } = (err ?? {}) as { name?: unknown; code?: unknown; constraint?: unknown };
  const parts = [typeof name === "string" ? name : "Error"];
  if (typeof code === "string") parts.push(`Postgres ${code}`);
  if (typeof constraint === "string") parts.push(`constraint ${constraint}`);
  return parts.join(", ");
}

export async function collectKalshi({ sql, mode, trigger, now = Date.now(), log = () => {}, ...apiOptions }: CollectOptions): Promise<CollectSummary> {
  const api = createKalshiApi(apiOptions);
  const clock = apiOptions.clock ?? Date.now;
  const runId = await startRun(sql, { collector: "kalshi", mode, trigger });
  log(`run ${runId}: ${mode}, ${trigger}`);

  let rowsInserted = 0;
  let rowsChanged = 0;
  let fetched = 0;
  let failed = 0;
  let gapSeries = 0;
  let status: CollectSummary["status"] = "failed";
  let error: string | null = null;
  let store: StoreSummary | null = null;

  async function fetchWindow(s: Series, window: TimeRange): Promise<void> {
    let source: KalshiSource = s.market.source;
    let result = await api.getCandles(source, s.ticker, s.period, window);
    if (!result.ok && result.error.code === "archived") {
      // Kalshi moved the market to its archive during the run: it serves the candles from now on.
      s.market.source = source = "historical";
      result = await api.getCandles(source, s.ticker, s.period, window);
    }
    if (!result.ok) {
      failed++;
      log(`${s.ticker} ${s.period}-min window failed: ${result.error.code}`);
      return;
    }
    const write = await writeWindow(sql, {
      runId,
      marketId: s.marketId,
      ticker: s.ticker,
      period: s.period,
      source,
      range: window,
      candles: result.data,
      fetchedAt: clock(),
    });
    fetched++;
    rowsInserted += write.inserted;
    rowsChanged += write.changed;
  }

  const fetchRanges = async (s: Series, ranges: TimeRange[]) => {
    for (const range of ranges) for (const window of splitWindows(range, s.period)) await fetchWindow(s, window);
  };

  try {
    const abandoned = await closeAbandonedRuns(sql, runId);
    if (abandoned.length) log(`marked ${plural(abandoned.length, "run")} that never finished as failed: ${abandoned.join(", ")}`);

    const discovery = await discoverMarkets(api, await readWatchlist(sql));
    if (!discovery.ok) {
      error = `Market discovery failed: ${discovery.error.code}`;
      log(error);
      return summary();
    }
    const { markets, unmatched } = discovery.data;
    if (unmatched.length) log(`no markets on Kalshi for ${unmatched.join(", ")}`);
    const written = await upsertMarkets(sql, markets);
    const archived = markets.filter((m) => m.source === "historical").length;
    log(
      `markets: ${markets.length} found (${markets.length - archived} live, ${archived} archived); ` +
        `${written.inserted} new, ${written.updated} updated`,
    );

    const series: Series[] = markets.flatMap((market) =>
      market.periods.flatMap((period: KalshiPeriod) => {
        const range = targetRange(market, period, now);
        const marketId = written.ids.get(market.ticker);
        return range && marketId !== undefined ? [{ ticker: market.ticker, period, range, market, marketId }] : [];
      }),
    );

    if (mode === "backfill") {
      for (const s of series) await fetchRanges(s, [s.range]);
    } else if (mode === "repair") {
      const gaps = await findTargetGaps(sql, series);
      for (const s of series) await fetchRanges(s, gaps.get(seriesId(s.ticker, s.period)) ?? []);
    } else {
      const ends = await coverageEnds(sql);
      for (const s of series) {
        const range = incrementalRange(s.range, ends.get(seriesId(s.ticker, s.period)) ?? null, s.period);
        if (range) await fetchRanges(s, [range]);
      }
      const gaps = await findTargetGaps(sql, series);
      const repairs = series.flatMap((s) =>
        (gaps.get(seriesId(s.ticker, s.period)) ?? []).flatMap((gap) => splitWindows(gap, s.period).map((window) => ({ s, window }))),
      );
      if (repairs.length) log(`repairing ${Math.min(repairs.length, REPAIR_CAP)} of ${plural(repairs.length, "gap window")}`);
      for (const { s, window } of repairs.slice(0, REPAIR_CAP)) await fetchWindow(s, window);
    }
    log(
      `candles: ${plural(fetched, "window")} stored, ${failed} failed, ${plural(api.requests, "request")}; ` +
        `${rowsInserted} inserted, ${rowsChanged} changed`,
    );

    const gaps = await findTargetGaps(sql, series);
    gapSeries = gaps.size;
    const gapTickers = [...new Set(series.filter((s) => gaps.has(seriesId(s.ticker, s.period))).map((s) => s.ticker))];
    log(gapSeries ? `gaps: ${plural(gapSeries, "series", "series")} in ${tickers(gapTickers)}` : "gaps: none");

    status = failed === 0 && gapSeries === 0 ? "ok" : "partial";
    if (status === "partial") {
      error = `${plural(failed, "window")} failed; ${plural(gapSeries, "series", "series")} with gaps`;
    }
    store = await storeSummary(sql);
    return summary();
  } catch (err) {
    status = "failed";
    error = `Unexpected error: ${describeError(err)}`;
    log(error);
    return summary();
  } finally {
    await finishRun(sql, runId, { status, requests: api.requests, credits: 0, rowsInserted, rowsChanged, error });
    log(`run ${runId}: ${status}`);
  }

  function summary(): CollectSummary {
    return { runId, status, requests: api.requests, rowsInserted, rowsChanged, windows: { fetched, failed }, gapSeries, error, store };
  }
}
