// Reads of stored Kalshi markets and candles (written by the Kalshi collector). Each takes the
// connection, so tests run them on PGlite as the app's role. Times are milliseconds.

import type { RawMarket } from "@/lib/kalshi/types";
import { findGaps, type TimeRange } from "@/lib/store/runs";
import type { Sql } from "@/lib/store/sql";
import type { PricedCandle } from "./merge";

export interface StoredMarket {
  /** The market object as Kalshi returned it. */
  raw: RawMarket;
  openTime: number | null;
  closeTime: number | null;
}

const time = (d: Date | null) => (d === null ? null : d.getTime());

export async function readStoredMarket(sql: Sql, ticker: string): Promise<StoredMarket | null> {
  const [row] = await sql.query<{ raw: RawMarket; open_time: Date | null; close_time: Date | null }>(
    "select raw, open_time, close_time from kalshi_markets where ticker = $1",
    [ticker],
  );
  return row ? { raw: row.raw, openTime: time(row.open_time), closeTime: time(row.close_time) } : null;
}

interface CandleRow {
  end_ts: Date;
  yes_bid_close: number | null;
  yes_ask_close: number | null;
  price_close: number | null;
  price_previous: number | null;
}

export interface StoredKalshiWindow {
  /** Null if the market isn't stored. */
  market: StoredMarket | null;
  /** Hourly candles ending in [from, to], oldest first, with only the fields probabilities need. */
  candles: PricedCandle[];
  /** The parts of [from, to) no fetch covered, oldest first. */
  gaps: TimeRange[];
}

/** A market's hourly candles in `range`, and what its coverage misses: three reads at once, so one round trip. */
export async function readStoredKalshiWindow(sql: Sql, ticker: string, range: TimeRange): Promise<StoredKalshiWindow> {
  const [market, rows, gaps] = await Promise.all([
    readStoredMarket(sql, ticker),
    // Prices are integer micro-dollars; the casts keep them numbers whatever the driver does with the domain.
    sql.query<CandleRow>(
      `select c.end_ts, c.yes_bid_close::int as yes_bid_close, c.yes_ask_close::int as yes_ask_close,
              c.price_close::int as price_close, c.price_previous::int as price_previous
         from kalshi_candles c join kalshi_markets m on m.id = c.market_id
        where m.ticker = $1 and c.period_min = 60 and c.end_ts >= $2 and c.end_ts <= $3
        order by c.end_ts`,
      [ticker, new Date(range.from), new Date(range.to)],
    ),
    findGaps(sql, { source: "kalshi", seriesKey: ticker, interval: "60" }, range),
  ]);
  return {
    market,
    candles: rows.map((r) => ({
      endTs: r.end_ts.getTime(),
      yesBid: { close: r.yes_bid_close },
      yesAsk: { close: r.yes_ask_close },
      price: { close: r.price_close, previous: r.price_previous },
    })),
    gaps,
  };
}
