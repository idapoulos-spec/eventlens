// Fills a test store (createTestDb) the way the collectors will: a run, then markets, candles,
// bars, and the coverage each fetch recorded. Written as the owner; the read path is then tested
// as the app's role.

import type { RawMarket } from "@/lib/kalshi/types";
import { recordCoverage, startRun } from "@/lib/store/runs";
import type { CoverageInterval, CoverageSource } from "@/lib/store/schema";
import type { Sql } from "@/lib/store/sql";
import { dollarsToMicros } from "@/lib/store/units";

export const HOUR_MS = 60 * 60 * 1000;
export const DAY_MS = 24 * HOUR_MS;

export function seedRun(sql: Sql, collector: "kalshi" | "stocks" = "kalshi"): Promise<number> {
  return startRun(sql, { collector, mode: "backfill", trigger: "local" });
}

export interface MarketSeed {
  ticker: string;
  status: string;
  openTime?: number | null;
  closeTime?: number | null;
  /** Fields of the market object beyond ticker, event, and status. */
  raw?: Partial<RawMarket>;
}

/** Stores a market and returns its id. */
export async function seedMarket(sql: Sql, { ticker, status, openTime = null, closeTime = null, raw = {} }: MarketSeed): Promise<number> {
  const eventTicker = ticker.split("-").slice(0, 2).join("-");
  const market: RawMarket = {
    ticker,
    event_ticker: eventTicker,
    status,
    title: "Stored market",
    open_time: openTime === null ? null : new Date(openTime).toISOString(),
    close_time: closeTime === null ? null : new Date(closeTime).toISOString(),
    ...raw,
  };
  const [row] = await sql.query<{ id: number }>(
    `insert into kalshi_markets (ticker, event_ticker, series_ticker, title, status, open_time, close_time, source, raw)
     values ($1, $2, $3, $4, $5, $6, $7, 'historical', $8) returning id`,
    [
      ticker,
      eventTicker,
      ticker.split("-")[0],
      market.title,
      status,
      openTime === null ? null : new Date(openTime),
      closeTime === null ? null : new Date(closeTime),
      JSON.stringify(market),
    ],
  );
  return row.id;
}

/** An hourly candle: prices in dollars as Kalshi quotes them; a missing one is left null. */
export interface CandleSeed {
  t: number;
  bid?: number;
  ask?: number;
  close?: number;
  previous?: number;
}

const micros = (dollars: number | undefined) => (dollars === undefined ? null : dollarsToMicros(dollars.toFixed(4)));

export async function seedCandles(sql: Sql, runId: number, marketId: number, candles: CandleSeed[]): Promise<void> {
  for (const c of candles) {
    await sql.query(
      `insert into kalshi_candles (market_id, period_min, end_ts, yes_bid_close, yes_ask_close, price_close, price_previous,
                                   source, fetched_at, run_id)
       values ($1, 60, $2, $3, $4, $5, $6, 'historical', now(), $7)`,
      [marketId, new Date(c.t), micros(c.bid), micros(c.ask), micros(c.close), micros(c.previous), runId],
    );
  }
}

export function seedCoverage(
  sql: Sql,
  runId: number,
  source: CoverageSource,
  seriesKey: string,
  interval: CoverageInterval,
  from: number,
  to: number,
): Promise<void> {
  return recordCoverage(sql, runId, { source, seriesKey, interval }, { from, to }, 0);
}

/** A stored bar: `start` is Twelve Data's datetime (UTC), `end` its close. */
export interface BarSeed {
  start: number;
  end: number;
  close: number;
}

export async function seedBars(
  sql: Sql,
  runId: number,
  symbol: string,
  interval: "30min" | "1day",
  bars: BarSeed[],
): Promise<void> {
  await sql.query(
    `insert into stock_instruments (symbol, exchange_timezone) values ($1, 'America/New_York') on conflict (symbol) do nothing`,
    [symbol],
  );
  for (const b of bars) {
    await sql.query(
      `insert into stock_bars (instrument_id, interval, bar_start, bar_end, trade_date, open, high, low, close, volume, fetched_at, run_id)
       select id, $2, $3::timestamptz, $4::timestamptz,
              ($3::timestamptz at time zone (case when $2 = '1day' then 'UTC' else 'America/New_York' end))::date,
              $5, $5, $5, $5, 1000, now(), $6
         from stock_instruments where symbol = $1`,
      [symbol, interval, new Date(b.start), new Date(b.end), b.close, runId],
    );
  }
}
