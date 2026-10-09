// A fake Kalshi API for the read path's tests: live and archived markets and hourly candles.

import { vi } from "vitest";
import type { RawMarket } from "@/lib/kalshi/types";

export interface FakeCandle {
  t: number;
  bid: number;
  ask: number;
}

export interface FakeKalshi {
  /** /markets/{ticker}: a market, or an HTTP status. */
  live?: RawMarket | number;
  /** /historical/markets/{ticker}: a market, or an HTTP status. */
  archive?: RawMarket | number;
  /** Candles the live endpoint serves. */
  candles?: FakeCandle[];
  /** Candles the archive serves. */
  archiveCandles?: FakeCandle[];
  /** Candle requests answer with this HTTP status instead. */
  candleStatus?: number;
}

const dollars = (v: number) => v.toFixed(4);

/** Stubs fetch; returns every requested URL, in order. */
export function stubKalshi(ticker: string, fake: FakeKalshi): URL[] {
  const calls: URL[] = [];
  vi.stubGlobal("fetch", async (input: string | URL) => {
    const url = new URL(String(input));
    calls.push(url);
    const path = url.pathname.replace("/trade-api/v2", "");
    const q = url.searchParams;
    const inRange = (c: FakeCandle) => c.t / 1000 >= Number(q.get("start_ts")) && c.t / 1000 <= Number(q.get("end_ts"));
    const respond = (body: RawMarket | number | undefined, wrap: (m: RawMarket) => unknown) =>
      typeof body === "object" ? Response.json(wrap(body)) : Response.json({}, { status: body ?? 404 });

    if (path === `/markets/${ticker}`) return respond(fake.live, (market) => ({ market }));
    if (path === `/historical/markets/${ticker}`) return respond(fake.archive, (market) => ({ market }));
    if (fake.candleStatus) return Response.json({}, { status: fake.candleStatus });
    if (path === "/markets/candlesticks") {
      const candlesticks = (fake.candles ?? []).filter(inRange).map((c) => ({
        end_period_ts: c.t / 1000,
        yes_bid: { close_dollars: dollars(c.bid) },
        yes_ask: { close_dollars: dollars(c.ask) },
        price: {},
      }));
      return Response.json({ markets: [{ market_ticker: ticker, candlesticks }] });
    }
    if (path === `/historical/markets/${ticker}/candlesticks`) {
      const candlesticks = (fake.archiveCandles ?? []).filter(inRange).map((c) => ({
        end_period_ts: c.t / 1000,
        yes_bid: { close: dollars(c.bid) },
        yes_ask: { close: dollars(c.ask) },
        price: { close: null, previous: null },
      }));
      return Response.json({ candlesticks });
    }
    return Response.json({}, { status: 404 });
  });
  return calls;
}

/** The path of each request, without the API's base path. */
export const paths = (calls: URL[]) => calls.map((u) => u.pathname.replace("/trade-api/v2", ""));
