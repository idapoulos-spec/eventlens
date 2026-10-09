// How stored and live history combine. Pure, so it's tested without a database or a network.

import { impliedProbability } from "@/lib/analytics";
import type { CandlePrices } from "@/lib/kalshi/candles";
import type { KalshiPoint } from "@/lib/kalshi/types";
import type { TimeRange } from "@/lib/store/runs";
import { microsToDollars } from "@/lib/store/units";

/**
 * What a window needs from the live API, given the parts of it no fetch covered (findGaps):
 * - stored: nothing, the store covers it all;
 * - tail: what came after `from`, the end of the stored history, as for an open market the
 *   collector last fetched a few hours ago;
 * - live: the whole window, when nothing is stored or a gap is at its start or in its middle.
 * Gaps outside `need` don't count: candles can't exist before a market opens, and Research
 * doesn't read past its close.
 */
export type CoveragePlan = { kind: "stored" } | { kind: "tail"; from: number } | { kind: "live" };

export function coveragePlan(gaps: TimeRange[], need: TimeRange): CoveragePlan {
  const missing = gaps
    .map((g) => ({ from: Math.max(g.from, need.from), to: Math.min(g.to, need.to) }))
    .filter((g) => g.from < g.to);
  if (missing.length === 0) return { kind: "stored" };
  const [gap] = missing;
  if (missing.length === 1 && gap.to === need.to && gap.from > need.from) return { kind: "tail", from: gap.from };
  return { kind: "live" };
}

/** Both series as one, oldest first. Where both have a point at the same time, `live`'s wins. */
export function mergeByTime<T extends { t: number }>(stored: T[], live: T[]): T[] {
  const byTime = new Map<number, T>();
  for (const p of stored) byTime.set(p.t, p);
  for (const p of live) byTime.set(p.t, p);
  return [...byTime.values()].sort((a, b) => a.t - b.t);
}

/** What candlePoints reads of a candle: a KalshiCandle, or a stored row. */
export interface PricedCandle {
  endTs: number;
  yesBid: Pick<CandlePrices, "close">;
  yesAsk: Pick<CandlePrices, "close">;
  price: Pick<CandlePrices, "close"> & { previous: number | null };
}

/**
 * Probability points from normalized candles (stored, or from Kalshi's archive), estimated
 * exactly as the live client does: the bid/ask midpoint, or the last trade (in the period, or
 * else before it) when the book is one-sided.
 */
export function candlePoints(candles: PricedCandle[]): KalshiPoint[] {
  const points: KalshiPoint[] = [];
  for (const c of candles) {
    const { value, source } = impliedProbability(
      microsToDollars(c.yesBid.close),
      microsToDollars(c.yesAsk.close),
      microsToDollars(c.price.close ?? c.price.previous),
    );
    if (value !== null && source !== "unavailable") points.push({ t: c.endTs, value, source });
  }
  return points.sort((a, b) => a.t - b.t);
}
