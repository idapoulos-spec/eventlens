// Reads of stored stock bars (written by the stock collector, on hold until Twelve Data confirms
// storing its data is allowed, so these find nothing for now). Bars come back in the shape the
// live client gives them (normalizeSeries), so either source serves the same code.

import { barCloseTime } from "@/lib/market-data/session";
import type { StockBar } from "@/lib/market-data/types";
import { findGaps, type TimeRange } from "@/lib/store/runs";
import type { StockInterval } from "@/lib/store/schema";
import type { Sql } from "@/lib/store/sql";

const HALF_HOUR_MS = 30 * 60 * 1000;

export interface StoredSeries {
  bars: StockBar[];
  exchangeTimeZone: string | undefined;
}

interface BarRow {
  bar_start: Date;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number | null;
  exchange_timezone: string | null;
}

/**
 * A symbol's bars of `interval` closing in `range`, oldest first, or null unless every part of
 * the range was fetched (a stored window with a gap would quietly drop bars). Stamped like the
 * live client's: 30-minute bars at their close, daily bars at 00:00 UTC of their trading date.
 */
export async function readStoredStockWindow(
  sql: Sql,
  symbol: string,
  interval: StockInterval,
  range: TimeRange,
): Promise<StoredSeries | null> {
  const [gaps, rows] = await Promise.all([
    findGaps(sql, { source: "twelve_data", seriesKey: symbol, interval }, range),
    sql.query<BarRow>(
      `select b.bar_start, b.open, b.high, b.low, b.close, b.volume::float8 as volume, i.exchange_timezone
         from stock_bars b join stock_instruments i on i.id = b.instrument_id
        where i.symbol = $1 and b.interval = $2 and b.bar_end >= $3 and b.bar_end < $4
        order by b.bar_start`,
      [symbol, interval, new Date(range.from), new Date(range.to)],
    ),
  ]);
  if (gaps.length > 0) return null;
  const exchangeTimeZone = rows[0]?.exchange_timezone ?? undefined;
  return {
    bars: rows.map((r) => ({
      t: interval === "30min" ? barCloseTime(r.bar_start.getTime(), HALF_HOUR_MS, exchangeTimeZone) : r.bar_start.getTime(),
      open: r.open,
      high: r.high,
      low: r.low,
      close: r.close,
      volume: r.volume,
    })),
    exchangeTimeZone,
  };
}
