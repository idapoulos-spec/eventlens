// A deterministic world for end-to-end tests of Research: Twelve Data bars that are the same
// whatever dates or size a request asks for, and Kalshi markets and Fed decision events with
// sparse hourly candles (a candle only when a quote changes, as Kalshi writes them).

import { vi } from "vitest";
import { describeRequest, OUTCOMES } from "@/lib/expected/test-fixtures";
import { mulberry32, type Rng } from "@/lib/analytics/random";
import type { RawMarket } from "@/lib/kalshi/types";
import { timeZoneOffsetMs } from "@/lib/market-data/session";

export const HOUR_MS = 60 * 60 * 1000;
export const DAY_MS = 24 * HOUR_MS;
const HALF_HOUR_MS = HOUR_MS / 2;
/** Twelve Data's history starts here; Kalshi markets open later. */
export const WORLD_START = Date.UTC(2024, 9, 1);
/** Bars are generated through here: later than any test's "now". */
const WORLD_END = Date.UTC(2026, 11, 31);

function normal(rng: Rng): number {
  const u = 1 - rng();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rng());
}

function seedOf(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 0x01000193);
  return h >>> 0;
}

/** 9:30 New York on every weekday (no holidays) from WORLD_START to WORLD_END, in UTC ms. */
const SESSION_OPENS: number[] = (() => {
  const opens: number[] = [];
  for (let d = WORLD_START; d < WORLD_END; d += DAY_MS) {
    if ([0, 6].includes(new Date(d).getUTCDay())) continue;
    const local = d + 9.5 * HOUR_MS;
    opens.push(local - timeZoneOffsetMs(d + 12 * HOUR_MS, "America/New_York"));
  }
  return opens;
})();

interface Bar {
  /** Open time (ms): Twelve Data's datetime. */
  open: number;
  close: number;
}

// Each symbol moves with a market factor (SPY's own moves) plus noise of its own.
const BETA: Record<string, number> = { SPY: 1, NVDA: 1.4, TLT: -0.3 };
const factor = (() => {
  const rng = mulberry32(seedOf("market"));
  return SESSION_OPENS.map(() => Array.from({ length: 13 }, (_, i) => (i === 0 ? 0.005 : 0.0012) * normal(rng)));
})();

const halfHourly = new Map<string, Bar[]>();
function barsOf(symbol: string): Bar[] {
  let bars = halfHourly.get(symbol);
  if (!bars) {
    const rng = mulberry32(seedOf(symbol));
    const beta = BETA[symbol] ?? 1;
    let price = 100;
    bars = SESSION_OPENS.flatMap((open, s) =>
      factor[s].map((m, i) => {
        const own = symbol === "SPY" ? 0 : (i === 0 ? 0.008 : 0.0025) * normal(rng);
        price *= Math.exp(beta * m + own);
        return { open: open + i * HALF_HOUR_MS, close: Number(price.toFixed(2)) };
      }),
    );
    halfHourly.set(symbol, bars);
  }
  return bars;
}

/** Daily bars (00:00 UTC of the trading date), each closing at its session's last half-hour close. */
function dailyOf(symbol: string): Bar[] {
  const bars = barsOf(symbol);
  return SESSION_OPENS.map((open, s) => ({ open: Math.floor(open / DAY_MS) * DAY_MS, close: bars[s * 13 + 12].close }));
}

const datetime = (ms: number) => new Date(ms).toISOString().slice(0, 19).replace("T", " ");

/** /time_series: bars opened by now within [start_date, end_date), newest first, at most outputsize. */
function timeSeries(q: URLSearchParams, now: number): Response {
  const symbol = q.get("symbol")!;
  const daily = q.get("interval") === "1day";
  const from = q.get("start_date") ? Date.parse(`${q.get("start_date")}T00:00:00Z`) : -Infinity;
  const to = q.get("end_date") ? Date.parse(`${q.get("end_date")}T00:00:00Z`) : Infinity;
  const values = (daily ? dailyOf(symbol) : barsOf(symbol))
    .filter((b) => b.open <= now && b.open >= from && b.open < to)
    .reverse()
    .slice(0, Number(q.get("outputsize")))
    .map((b) => {
      const close = String(b.close);
      return { datetime: daily ? datetime(b.open).slice(0, 10) : datetime(b.open), open: close, high: close, low: close, close, volume: "1000" };
    });
  return Response.json({ status: "ok", meta: { exchange_timezone: "America/New_York" }, values });
}

// ---- Kalshi ----

/** One outcome market's quotes: the hours its book changed, and the book (cents) from then on. */
interface Quote {
  t: number;
  bid: number;
  ask: number;
}

export interface WorldMarket {
  ticker: string;
  event: string;
  status: "active" | "finalized";
  open: number;
  close: number;
  /** Settled before Kalshi's archive cutoff: the live endpoints answer 404. */
  archived: boolean;
  raw: RawMarket;
  quotes: Quote[];
}

/** A market's mid (cents) moves a cent or two in about 8% of hours, a few cents now and then; candles only when it moves. */
function marketQuotes(ticker: string, open: number, close: number): Quote[] {
  const rng = mulberry32(seedOf(ticker));
  let mid = 40;
  let last = 0;
  const quotes: Quote[] = [];
  for (let t = Math.ceil(open / HOUR_MS) * HOUR_MS; t <= close + HOUR_MS; t += HOUR_MS) {
    const u = rng();
    const step = u < 0.06 ? (rng() < 0.65 && last ? last : rng() < 0.5 ? -1 : 1) : u < 0.08 ? Math.round(normal(rng) * 4) : 0;
    last = step === 0 ? 0 : Math.sign(step);
    mid = Math.min(96, Math.max(4, mid + step));
    if (quotes.length === 0 || step !== 0) quotes.push({ t, bid: mid - 1, ask: mid + 1 });
  }
  return quotes;
}

/** An event's outcomes: cents move between the hold and the cut or hike outcomes in about 10% of hours. */
function eventQuotes(event: string, open: number, close: number): Map<string, Quote[]> {
  const rng = mulberry32(seedOf(event));
  const mids = new Map(OUTCOMES.map(([suffix]) => [suffix, { C26: 3, C25: 12, H0: 70, H25: 12, H26: 3 }[suffix]!]));
  const quotes = new Map<string, Quote[]>(OUTCOMES.map(([suffix]) => [suffix, []]));
  const write = (t: number, suffix: string) => quotes.get(suffix)!.push({ t, bid: mids.get(suffix)! - 1, ask: mids.get(suffix)! + 1 });
  for (let t = Math.ceil(open / HOUR_MS) * HOUR_MS; t <= close + HOUR_MS; t += HOUR_MS) {
    if (quotes.get("H0")!.length === 0) {
      for (const [suffix] of OUTCOMES) write(t, suffix);
      continue;
    }
    if (rng() >= 0.1) continue;
    const other = ["C26", "C25", "H25", "H26"][Math.floor(rng() * 4)];
    const cents = rng() < 0.8 ? 1 : 3;
    const sign = rng() < 0.5 ? -1 : 1;
    const next = mids.get(other)! + sign * cents;
    if (next < 2 || next > 40) continue;
    mids.set(other, next);
    mids.set("H0", mids.get("H0")! - sign * cents);
    write(t, other);
    write(t, "H0");
  }
  return quotes;
}

const iso = (ms: number) => new Date(ms).toISOString();

function rawMarket(ticker: string, event: string, status: string, open: number, close: number, extra: Record<string, unknown> = {}): RawMarket {
  return {
    ticker,
    event_ticker: event,
    status,
    title: "Will the Federal Reserve hold rates?",
    subtitle: "Fed maintains rate",
    yes_sub_title: "Fed maintains rate",
    open_time: iso(open),
    close_time: iso(close),
    yes_bid_dollars: "0.4000",
    yes_ask_dollars: "0.4200",
    ...extra,
  } as RawMarket;
}

/** One market, quoted on its own. */
export function worldMarket(ticker: string, { status, open, close, archived }: Omit<WorldMarket, "ticker" | "event" | "raw" | "quotes">): WorldMarket {
  const event = ticker.split("-").slice(0, 2).join("-");
  return { ticker, event, status, open, close, archived, raw: rawMarket(ticker, event, status, open, close), quotes: marketQuotes(ticker, open, close) };
}

/** A Fed decision event's five outcomes, quoted together. */
export function worldEvent(event: string, { status, open, close, archived }: Omit<WorldMarket, "ticker" | "event" | "raw" | "quotes">): WorldMarket[] {
  const quotes = eventQuotes(event, open, close);
  return OUTCOMES.map(([suffix, strike, label]) => {
    const [word, amount] = Object.entries(strike)[0];
    const ticker = `${event}-${suffix}`;
    return {
      ticker,
      event,
      status,
      open,
      close,
      archived,
      raw: rawMarket(ticker, event, status, open, close, {
        yes_sub_title: label,
        title: `Will the Federal Reserve ${word} rates by ${amount}bps?`,
        rules_primary: `If the Federal Reserve does a ${word} of ${amount}bps, then the market resolves to Yes.`,
        custom_strike: strike,
        result: status === "finalized" ? (suffix === "H0" ? "yes" : "no") : "",
      }),
      quotes: quotes.get(suffix)!,
    };
  });
}

const dollars = (cents: number) => (cents / 100).toFixed(4);

/** Stubs fetch with this world's Twelve Data and Kalshi; returns every request, described. */
export function stubWorld(markets: WorldMarket[]): string[] {
  const requests: string[] = [];
  const byTicker = new Map(markets.map((m) => [m.ticker, m]));
  vi.stubGlobal("fetch", async (input: string | URL) => {
    const url = new URL(String(input));
    requests.push(describeRequest(url));
    const now = Date.now();
    const q = url.searchParams;
    if (url.hostname.includes("twelvedata")) {
      if (url.pathname === "/quote") return Response.json({ symbol: q.get("symbol"), close: "100", datetime: datetime(now).slice(0, 10), is_market_open: true });
      if (url.pathname === "/time_series") return timeSeries(q, now);
      return Response.json({}, { status: 404 });
    }

    const path = url.pathname.replace("/trade-api/v2", "");
    const inRange = (t: number) => t / 1000 >= Number(q.get("start_ts")) && t / 1000 <= Number(q.get("end_ts")) && t <= now;
    const candles = (m: WorldMarket, live: boolean) =>
      m.quotes.filter((c) => inRange(c.t)).map((c) => ({
        end_period_ts: c.t / 1000,
        yes_bid: live ? { close_dollars: dollars(c.bid) } : { close: dollars(c.bid) },
        yes_ask: live ? { close_dollars: dollars(c.ask) } : { close: dollars(c.ask) },
        price: live ? {} : { close: null, previous: null },
      }));

    let match: RegExpExecArray | null;
    if (path === "/markets/trades") return Response.json({ trades: [] });
    if (path === "/markets/candlesticks") {
      const tickers = (q.get("market_tickers") ?? "").split(",").map((t) => byTicker.get(t)).filter((m) => m && !m.archived) as WorldMarket[];
      return Response.json({ markets: tickers.map((m) => ({ market_ticker: m.ticker, candlesticks: candles(m, true) })) });
    }
    if ((match = /^\/historical\/markets\/([^/]+)\/candlesticks$/.exec(path))) {
      const m = byTicker.get(match[1]);
      return m?.archived ? Response.json({ candlesticks: candles(m, false) }) : Response.json({}, { status: 404 });
    }
    if ((match = /^\/historical\/markets\/([^/]+)$/.exec(path))) {
      const m = byTicker.get(match[1]);
      return m?.archived ? Response.json({ market: m.raw }) : Response.json({}, { status: 404 });
    }
    if (path === "/historical/markets") {
      return Response.json({ markets: markets.filter((m) => m.archived && m.event === q.get("event_ticker")).map((m) => m.raw), cursor: "" });
    }
    if ((match = /^\/markets\/([^/]+)$/.exec(path))) {
      const m = byTicker.get(match[1]);
      return m && !m.archived ? Response.json({ market: m.raw }) : Response.json({}, { status: 404 });
    }
    if ((match = /^\/events\/([^/]+)$/.exec(path))) {
      const outcomes = markets.filter((m) => m.event === match![1]);
      if (outcomes.length === 0) return Response.json({}, { status: 404 });
      const live = outcomes.filter((m) => !m.archived).map((m) => m.raw);
      return Response.json({ event: { event_ticker: match[1], series_ticker: "KXFEDDECISION", title: "Fed decision", mutually_exclusive: true, markets: live }, markets: [] });
    }
    return Response.json({}, { status: 404 });
  });
  return requests;
}
