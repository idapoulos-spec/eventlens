// Reads of a stored event (written by the Kalshi collector): its outcome markets, their hourly
// books, each one's last usable book before them, and what the collector covered. Each read is one
// query; the history's three run at once, and each takes the connection, so tests run them on PGlite as the app's role
// and the parity script on the store. Times are milliseconds.

import type { RawMarket } from "@/lib/kalshi/types";
import type { TimeRange } from "@/lib/store/runs";
import type { Sql } from "@/lib/store/sql";
import { microsToDollars } from "@/lib/store/units";
import { estimate, mergeRanges, type OutcomeCandle } from "./engine";

export interface StoredOutcome {
  ticker: string;
  /** The market object as Kalshi returned it. */
  raw: RawMarket;
  status: string;
  openTime: number | null;
  closeTime: number | null;
}

export interface StoredHistory {
  /** Each outcome's hourly books ending in [from, to], oldest first. */
  candles: Map<string, OutcomeCandle[]>;
  /** Each outcome's last usable estimate before `from`; absent if it never had one. */
  seeds: Map<string, number>;
  /** Each outcome's covered ranges of hourly candle end times, merged. */
  covered: Map<string, TimeRange[]>;
}

const time = (d: Date | null) => (d === null ? null : d.getTime());

// A book with a usable quote (rules 1–3 of engine.ts's estimate): a bid above 0 or an ask below $1,
// and not crossed. Prices are integer micro-dollars.
const USABLE = `(
  (coalesce(c.yes_bid_close > 0, false) and coalesce(c.yes_ask_close < 1000000, false) and c.yes_ask_close >= c.yes_bid_close)
  or (coalesce(c.yes_bid_close > 0, false) <> coalesce(c.yes_ask_close < 1000000, false))
)`;

/** Every stored market of an event, by ticker; empty if the event isn't stored. */
export async function readStoredOutcomes(sql: Sql, eventTicker: string): Promise<StoredOutcome[]> {
  const rows = await sql.query<{ ticker: string; raw: RawMarket; status: string; open_time: Date | null; close_time: Date | null }>(
    "select ticker, raw, status, open_time, close_time from kalshi_markets where event_ticker = $1 order by ticker",
    [eventTicker],
  );
  return rows.map((m) => ({ ticker: m.ticker, raw: m.raw, status: m.status, openTime: time(m.open_time), closeTime: time(m.close_time) }));
}

/** An event's stored history around `range`: three reads at once, so one round trip. */
export async function readStoredHistory(sql: Sql, eventTicker: string, range: TimeRange): Promise<StoredHistory> {
  const [rows, seeds, coverage] = await Promise.all([
    // The casts keep prices numbers whatever the driver does with the domain.
    sql.query<{ ticker: string; end_ts: Date; bid: number | null; ask: number | null }>(
      `select m.ticker, c.end_ts, c.yes_bid_close::int as bid, c.yes_ask_close::int as ask
         from kalshi_candles c join kalshi_markets m on m.id = c.market_id
        where m.event_ticker = $1 and c.period_min = 60 and c.end_ts >= $2 and c.end_ts <= $3
        order by m.ticker, c.end_ts`,
      [eventTicker, new Date(range.from), new Date(range.to)],
    ),
    // Walks each market's candles back from `from` on the primary key.
    sql.query<{ ticker: string; bid: number | null; ask: number | null }>(
      `select m.ticker, s.bid, s.ask
         from kalshi_markets m
         cross join lateral (
           select c.yes_bid_close::int as bid, c.yes_ask_close::int as ask
             from kalshi_candles c
            where c.market_id = m.id and c.period_min = 60 and c.end_ts < $2 and ${USABLE}
            order by c.end_ts desc
            limit 1
         ) s
        where m.event_ticker = $1`,
      [eventTicker, new Date(range.from)],
    ),
    sql.query<{ series_key: string; from: Date; to: Date }>(
      `select series_key, lower(covered) as "from", upper(covered) as "to"
         from fetch_coverage
        where source = 'kalshi' and interval = '60'
          and series_key in (select ticker from kalshi_markets where event_ticker = $1)`,
      [eventTicker],
    ),
  ]);

  const candles = new Map<string, OutcomeCandle[]>();
  for (const r of rows) {
    const list = candles.get(r.ticker) ?? [];
    list.push({ endTs: r.end_ts.getTime(), bid: microsToDollars(r.bid), ask: microsToDollars(r.ask) });
    candles.set(r.ticker, list);
  }
  const seedMap = new Map<string, number>();
  for (const s of seeds) {
    const e = estimate(microsToDollars(s.bid), microsToDollars(s.ask));
    if (e.p !== null) seedMap.set(s.ticker, e.p);
  }
  const ranges = new Map<string, TimeRange[]>();
  for (const c of coverage) {
    const list = ranges.get(c.series_key) ?? [];
    list.push({ from: c.from.getTime(), to: c.to.getTime() });
    ranges.set(c.series_key, list);
  }
  return {
    candles,
    seeds: seedMap,
    covered: new Map([...ranges].map(([k, v]) => [k, mergeRanges(v)])),
  };
}
