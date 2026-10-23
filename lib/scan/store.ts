// The scan's reads of the data store: which events and markets it holds. One query each; times are milliseconds.

import type { RawMarket } from "@/lib/kalshi/types";
import type { Sql } from "@/lib/store/sql";

/** Rows read at most per listing: far more than any series the collector watches. */
const MAX_ROWS = 5_000;

export interface StoredMarketRow {
  ticker: string;
  event: string;
  series: string | null;
  raw: RawMarket;
}

/** Every stored market, of one series or all, ordered by event and ticker. */
export async function readStoredMarkets(sql: Sql, series: string | null): Promise<StoredMarketRow[]> {
  const rows = await sql.query<{ ticker: string; event_ticker: string; series_ticker: string | null; raw: RawMarket }>(
    `select ticker, event_ticker, series_ticker, raw from kalshi_markets
      ${series === null ? "" : "where series_ticker = $1"}
      order by event_ticker, ticker limit ${MAX_ROWS}`,
    series === null ? [] : [series],
  );
  return rows.map((r) => ({ ticker: r.ticker, event: r.event_ticker, series: r.series_ticker, raw: r.raw }));
}

/** Which of these tickers (events or markets) the store holds. */
export async function readStoredTickers(sql: Sql, tickers: string[]): Promise<Set<string>> {
  if (tickers.length === 0) return new Set();
  const rows = await sql.query<{ ticker: string; event_ticker: string }>(
    "select ticker, event_ticker from kalshi_markets where ticker = any($1) or event_ticker = any($1)",
    [tickers],
  );
  return new Set(rows.flatMap((r) => [r.ticker, r.event_ticker]));
}
