// Each outcome's history for the engine, from stored candles, live ones, or both. Pure, so the
// read path and the parity script build it the same way.

import { mergeByTime } from "@/lib/history/merge";
import type { TimeRange } from "@/lib/store/runs";
import { mergeRanges, type OutcomeCandle, type OutcomeHistory } from "./engine";
import type { StoredHistory } from "./store";

/** What the engine needs to know about an outcome besides its candles. */
export interface OutcomeMeta {
  ticker: string;
  value: number;
  /** Null if Kalshi didn't say: then it's treated as always open, or never closing. */
  openTime: number | null;
  closeTime: number | null;
}

const times = ({ ticker, value, openTime, closeTime }: OutcomeMeta) => ({
  ticker,
  value,
  openTime: openTime ?? -Infinity,
  closeTime: closeTime ?? Infinity,
});

/** The parts of `range` that no range in `covered` (merged) includes, oldest first. */
export function gapsIn(covered: TimeRange[], range: TimeRange): TimeRange[] {
  const gaps: TimeRange[] = [];
  let from = range.from;
  for (const r of covered) {
    if (r.to <= from) continue;
    if (r.from >= range.to) break;
    if (r.from > from) gaps.push({ from, to: r.from });
    from = Math.max(from, r.to);
    if (from >= range.to) break;
  }
  if (from < range.to) gaps.push({ from, to: range.to });
  return gaps;
}

/** An outcome from the store alone: its candles, coverage, and last usable estimate before them. */
export function storedOutcome(meta: OutcomeMeta, stored: StoredHistory): OutcomeHistory {
  return {
    ...times(meta),
    candles: stored.candles.get(meta.ticker) ?? [],
    covered: stored.covered.get(meta.ticker) ?? [],
    seed: stored.seeds.get(meta.ticker) ?? null,
  };
}

/**
 * Candles ending in `fetched` (inclusive at both ends, as Kalshi serves them) added to a history:
 * where both have a candle, the live one wins, and the fetched window counts as covered.
 */
export function withLive(history: OutcomeHistory, live: OutcomeCandle[], fetched: TimeRange): OutcomeHistory {
  const byT = mergeByTime(
    history.candles.map((c) => ({ ...c, t: c.endTs })),
    live.map((c) => ({ ...c, t: c.endTs })),
  );
  return {
    ...history,
    candles: byT.map(({ endTs, bid, ask }) => ({ endTs, bid, ask })),
    covered: mergeRanges([...history.covered, { from: fetched.from, to: fetched.to + 1 }]),
  };
}

/**
 * An outcome from live candles alone. What came before them is unknown, unless they start at or
 * before its open, when it never had a quote before them.
 */
export function liveOutcome(meta: OutcomeMeta, live: OutcomeCandle[], fetched: TimeRange): OutcomeHistory {
  const known = meta.openTime !== null && fetched.from <= meta.openTime;
  return withLive({ ...times(meta), candles: [], covered: [], seed: known ? null : "unknown" }, live, fetched);
}
