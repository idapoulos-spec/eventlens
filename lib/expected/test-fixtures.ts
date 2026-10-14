// A Fed decision event for the read path's tests: its outcome markets as Kalshi words them, and a
// fake Kalshi that serves the event, its candles (live, batched, or archived), and its archive list.

import { vi } from "vitest";
import type { RawMarket } from "@/lib/kalshi/types";

export const HOUR_MS = 60 * 60 * 1000;
export const DAY_MS = 24 * HOUR_MS;

/** suffix, custom_strike, YES label, and a closing book (bid, ask) the fake candles hold. */
export const OUTCOMES: [string, Record<string, string>, string, number, number][] = [
  ["C26", { Cut: ">25" }, "Cut >25bps", 0, 0.01],
  ["C25", { Cut: "25" }, "Cut 25bps", 0.09, 0.11],
  ["H0", { Hike: "0" }, "Fed maintains rate", 0.79, 0.81],
  ["H25", { Hike: "25" }, "Hike 25bps", 0.04, 0.06],
  ["H26", { Hike: ">25" }, "Hike >25bps", 0, 0.01],
];

export function fedMarkets(event: string, { status, open, close }: { status: string; open: number; close: number }): RawMarket[] {
  return OUTCOMES.map(([suffix, strike, label, bid, ask]) => {
    const [word, amount] = Object.entries(strike)[0];
    return {
      ticker: `${event}-${suffix}`,
      event_ticker: event,
      status,
      yes_sub_title: label,
      title: `Will the Federal Reserve ${word} rates by ${amount}bps?`,
      rules_primary: `If the Federal Reserve does a ${word} of ${amount}bps, then the market resolves to Yes.`,
      custom_strike: strike,
      open_time: new Date(open).toISOString(),
      close_time: new Date(close).toISOString(),
      yes_bid_dollars: bid.toFixed(4),
      yes_ask_dollars: ask.toFixed(4),
      result: status === "finalized" ? (suffix === "H0" ? "yes" : "no") : "",
    } as RawMarket;
  });
}

/** The book of an outcome's fake candles, by ticker suffix. */
export const bookOf = (ticker: string) => OUTCOMES.find(([suffix]) => ticker.endsWith(`-${suffix}`))!;

export interface FakeEvent {
  ticker: string;
  /** The live event's markets: empty once archived. */
  live: RawMarket[];
  /** The archive's markets for the event. */
  archive?: RawMarket[];
  /** Candle end times every outcome has a candle at (its fixed book). */
  candleTimes: number[];
}

/** One request in a readable form: host, path, and the parameters that tell requests apart. */
export function describeRequest(url: URL): string {
  const keep = ["symbol", "interval", "outputsize", "start_date", "end_date", "period_interval", "start_ts", "end_ts", "market_tickers", "event_ticker"];
  const q = [...url.searchParams].filter(([k]) => keep.includes(k)).map(([k, v]) => `${k}=${v}`);
  const host = url.hostname.includes("kalshi") ? "kalshi" : "twelvedata";
  return `${host} ${url.pathname.replace("/trade-api/v2", "")}${q.length ? ` ${q.join(" ")}` : ""}`;
}

/** Stubs fetch for Kalshi (this event only) and Twelve Data; returns every request, described. */
export function stubUpstreams(fake: FakeEvent): string[] {
  const requests: string[] = [];
  vi.stubGlobal("fetch", async (input: string | URL) => {
    const url = new URL(String(input));
    requests.push(describeRequest(url));
    const path = url.pathname.replace("/trade-api/v2", "");
    const q = url.searchParams;
    const inRange = (t: number) => t / 1000 >= Number(q.get("start_ts")) && t / 1000 <= Number(q.get("end_ts"));
    const candles = (ticker: string, live: boolean) => {
      const [, , , bid, ask] = bookOf(ticker);
      return fake.candleTimes.filter(inRange).map((t) => ({
        end_period_ts: t / 1000,
        yes_bid: live ? { close_dollars: bid.toFixed(4) } : { close: bid.toFixed(4) },
        yes_ask: live ? { close_dollars: ask.toFixed(4) } : { close: ask.toFixed(4) },
        price: {},
      }));
    };

    if (path === `/events/${fake.ticker}`) {
      return Response.json({ event: { event_ticker: fake.ticker, series_ticker: "KXFEDDECISION", title: "Fed decision", mutually_exclusive: true, markets: fake.live }, markets: [] });
    }
    if (path === "/historical/markets" && q.get("event_ticker") === fake.ticker) return Response.json({ markets: fake.archive ?? [], cursor: "" });
    if (path === "/markets/candlesticks") {
      const tickers = (q.get("market_tickers") ?? "").split(",");
      return Response.json({ markets: tickers.map((t) => ({ market_ticker: t, candlesticks: candles(t, true) })) });
    }
    const archived = /^\/historical\/markets\/([^/]+)\/candlesticks$/.exec(path);
    if (archived) return Response.json({ candlesticks: candles(archived[1], false) });
    if (path === "/quote") return Response.json({ symbol: "TLT", close: "90", datetime: "2026-10-07", is_market_open: true });
    if (path === "/time_series") {
      const daily = q.get("interval") === "1day";
      return Response.json({
        status: "ok",
        meta: { exchange_timezone: "America/New_York" },
        values: [{ datetime: daily ? "2026-10-06" : "2026-10-07 14:00:00", open: "1", high: "1", low: "1", close: "1" }],
      });
    }
    return Response.json({}, { status: 404 });
  });
  return requests;
}
