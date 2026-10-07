// Kalshi returns candlesticks in two shapes: /markets/candlesticks names its fields `close_dollars`
// and `volume_fp`, while /historical (markets settled before the archive cutoff) names the same
// fields `close` and `volume`. Both become one KalshiCandle, in the store's integer units, so
// collectors and the read path never see the difference.

import { contractsToHundredths, dollarsToMicros } from "@/lib/store/units";
import type { RawCandlestick, RawHistoricalCandlestick } from "./types";

/** Open, high, low, close in micro-dollars; null where Kalshi left the value out. */
export interface CandlePrices {
  open: number | null;
  high: number | null;
  low: number | null;
  close: number | null;
}

export interface KalshiCandle {
  /** The end of the period (ms). Kalshi stamps candles at their end. */
  endTs: number;
  yesBid: CandlePrices;
  yesAsk: CandlePrices;
  /** Trade prices: null without a trade in the period, except `previous`, the close of the last period with one. */
  price: CandlePrices & { mean: number | null; previous: number | null };
  /** Hundredths of a contract. */
  volume: number | null;
  openInterest: number | null;
}

type Fields = Partial<Record<"open" | "high" | "low" | "close" | "mean" | "previous", string | null>>;

/** A price object from either shape, keyed without the `_dollars` suffix. */
function fields(ohlc: object | undefined): Fields {
  const out: Fields = {};
  for (const [key, value] of Object.entries(ohlc ?? {})) {
    out[key.replace(/_dollars$/, "") as keyof Fields] = value as string | null;
  }
  return out;
}

function prices(ohlc: object | undefined): CandlePrices {
  const f = fields(ohlc);
  return {
    open: dollarsToMicros(f.open),
    high: dollarsToMicros(f.high),
    low: dollarsToMicros(f.low),
    close: dollarsToMicros(f.close),
  };
}

/** Either candlestick shape as a KalshiCandle. Throws a RangeError on a price outside $0–$1. */
export function normalizeCandle(raw: RawCandlestick | RawHistoricalCandlestick): KalshiCandle {
  const live = raw as RawCandlestick;
  const historical = raw as RawHistoricalCandlestick;
  const price = fields(raw.price);
  return {
    endTs: raw.end_period_ts * 1000,
    yesBid: prices(raw.yes_bid),
    yesAsk: prices(raw.yes_ask),
    price: { ...prices(raw.price), mean: dollarsToMicros(price.mean), previous: dollarsToMicros(price.previous) },
    volume: contractsToHundredths(live.volume_fp ?? historical.volume),
    openInterest: contractsToHundredths(live.open_interest_fp ?? historical.open_interest),
  };
}

/** Candles oldest first. */
export function toKalshiCandles(raw: (RawCandlestick | RawHistoricalCandlestick)[]): KalshiCandle[] {
  return raw.map(normalizeCandle).sort((a, b) => a.endTs - b.endTs);
}
