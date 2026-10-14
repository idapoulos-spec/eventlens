// The expected value of a multi-outcome event at any moment: E(t) = Σ pᵢ·vᵢ / Σ pᵢ over the
// outcomes open at t, from each outcome's hourly candles. An exact port of the fed-history study's
// kalshi.py (estimate, Outcome.at, covered, build), so stored results match it. Pure, so it's
// tested directly and the parity script runs it on the store. Prices are dollars (0–1).

import type { TimeRange } from "@/lib/store/runs";

const HOUR_MS = 60 * 60 * 1000;
/** An outcome's latest candle counts only if it ended less than this long before the mark. */
export const LOOKBACK_MS = 7 * 24 * HOUR_MS;
/** Rule 4: a silent outcome counts as 0 if its last estimate was at most this. */
export const STALE_MAX = 0.05;
/** Σp outside this range (inclusive): the book doesn't hang together. */
export const SUM_RANGE: readonly [number, number] = [0.8, 1.2];

/**
 * How a probability was estimated from a closing book:
 * 1: the bid/ask midpoint; 2: half the ask (no bid); 3: halfway from the bid to $1 (no ask).
 */
export type Rule = 1 | 2 | 3;

export type Estimate = { p: number; rule: Rule } | { p: null; rule: "crossed" | 4 };

/** One candle's closing book as a probability. A bid of 0 or an ask of $1 is no quote. */
export function estimate(bid: number | null, ask: number | null): Estimate {
  const hasBid = bid !== null && bid > 0;
  const hasAsk = ask !== null && ask < 1;
  if (hasBid && hasAsk) return ask >= bid ? { p: (bid + ask) / 2, rule: 1 } : { p: null, rule: "crossed" };
  if (hasAsk) return { p: ask / 2, rule: 2 };
  if (hasBid) return { p: (bid + 1) / 2, rule: 3 };
  return { p: null, rule: 4 };
}

/** An hourly candle's closing book, in dollars. */
export interface OutcomeCandle {
  endTs: number;
  bid: number | null;
  ask: number | null;
}

/**
 * The last usable estimate before an outcome's loaded candles: a probability, null when it never
 * had one, or "unknown" when the history before the loaded candles wasn't read (live data).
 */
export type Seed = number | null | "unknown";

export interface OutcomeHistory {
  ticker: string;
  /** What the outcome is worth (e.g. basis points). */
  value: number;
  openTime: number;
  closeTime: number;
  /** Hourly candles, oldest first. */
  candles: OutcomeCandle[];
  /** Sorted, non-overlapping [from, to) ranges of candle end times that some fetch covered. */
  covered: TimeRange[];
  seed: Seed;
}

/** Why an outcome has no probability at a mark. */
export type OutcomeMissing =
  /** No fetch covered the time since its latest candle (or the last 7 days), so a candle may be missing. */
  | "coverage"
  /** No usable quote in the last 7 days, and its last estimate was above 5¢. */
  | "stale_quote"
  /** No usable quote in the loaded history, and what came before it wasn't loaded. */
  | "history_incomplete";

/** One outcome at one mark: its probability and how it was found, or why there's none. */
export type OutcomeState = { p: number; rule: Rule | "4_zero" } | { p: null; rule: OutcomeMissing };

/** Why E is missing at a mark. */
export type ExpectedMissing = "after_close" | "not_open" | "sum_out_of_range" | OutcomeMissing;

export interface ExpectedMark {
  t: number;
  /** Null when missing. */
  value: number | null;
  /** Σp over the open outcomes, when every one has a probability. */
  sumP: number | null;
  /** Tickers of the outcomes open at t, sorted; empty when E is missing for a reason before them. */
  openSet: string[];
  /** Each open outcome's probability, in `openSet`'s order, when every one has one. */
  p: number[] | null;
  missing: ExpectedMissing | null;
}

/** Merges coverage ranges as the study's merged_coverage: sorted by start, touching ranges joined. */
export function mergeRanges(ranges: TimeRange[]): TimeRange[] {
  const merged: TimeRange[] = [];
  for (const r of [...ranges].sort((a, b) => a.from - b.from)) {
    const last = merged.at(-1);
    if (last && r.from <= last.to) last.to = Math.max(last.to, r.to);
    else merged.push({ ...r });
  }
  return merged;
}

const floorHour = (t: number) => Math.floor(t / HOUR_MS) * HOUR_MS;

/** Whether every hourly candle end in (after, upto] lies inside one covered range. */
export function covered(ranges: TimeRange[], after: number, upto: number): boolean {
  const first = floorHour(after) + HOUR_MS;
  if (first > upto) return true;
  return ranges.some((r) => r.from <= first && r.to > upto);
}

/** One outcome's candles with each one's estimate and the last usable estimate so far (Outcome in kalshi.py). */
export class Outcome {
  readonly ends: number[];
  readonly estimates: Estimate[];
  /** After each candle: the last usable estimate up to it (seed included). */
  readonly lastUsable: Seed[];

  constructor(readonly history: OutcomeHistory) {
    const candles = [...history.candles].sort((a, b) => a.endTs - b.endTs);
    this.ends = candles.map((c) => c.endTs);
    this.estimates = candles.map((c) => estimate(c.bid, c.ask));
    let last: Seed = history.seed;
    this.lastUsable = this.estimates.map((e) => {
      if (e.p !== null) last = e.p;
      return last;
    });
  }

  /** Index of the latest candle ending at or before t, or −1. */
  private latest(t: number): number {
    let lo = 0;
    let hi = this.ends.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (this.ends[mid] <= t) lo = mid + 1;
      else hi = mid;
    }
    return lo - 1;
  }

  /** The outcome's probability at mark t. */
  at(t: number): OutcomeState {
    const i = this.latest(t);
    const hasRecent = i >= 0 && this.ends[i] > t - LOOKBACK_MS;
    const after = hasRecent ? this.ends[i] : Math.max(t - LOOKBACK_MS, this.history.openTime);
    if (!covered(this.history.covered, after, t)) return { p: null, rule: "coverage" };
    if (hasRecent) {
      const e = this.estimates[i];
      if (e.p !== null) return { p: e.p, rule: e.rule };
    }
    return this.silent(i >= 0 ? this.lastUsable[i] : this.history.seed);
  }

  /** Rule 4, for an outcome without a usable quote: 0 if it was at most 5¢ or never quoted. */
  silent(last: Seed): OutcomeState {
    if (last === "unknown") return { p: null, rule: "history_incomplete" };
    if (last === null || last <= STALE_MAX) return { p: 0, rule: "4_zero" };
    return { p: null, rule: "stale_quote" };
  }

  /** The last usable estimate up to and including candles ending at or before t. */
  lastUsableAt(t: number): Seed {
    const i = this.latest(t);
    return i >= 0 ? this.lastUsable[i] : this.history.seed;
  }
}

/** E from the open outcomes' states, or why there's none (the part of build() after the open set). */
export function combine(open: { value: number; ticker: string }[], states: OutcomeState[]): Omit<ExpectedMark, "t"> {
  const openSet = open.map((o) => o.ticker).sort();
  // Callers pass outcomes in ticker order, so sums and the first reason follow the study's order.
  const reasons = states.filter((s) => s.p === null).map((s) => s.rule as OutcomeMissing);
  if (reasons.length > 0) {
    return { value: null, sumP: null, openSet, p: null, missing: reasons.includes("coverage") ? "coverage" : reasons[0] };
  }
  // Summed in order, as NumPy does for so few terms.
  let total = 0;
  let weighted = 0;
  states.forEach((s, k) => {
    total += s.p!;
    weighted += s.p! * open[k].value;
  });
  const p = states.map((s) => s.p!);
  if (!(SUM_RANGE[0] <= total && total <= SUM_RANGE[1])) return { value: null, sumP: total, openSet, p, missing: "sum_out_of_range" };
  return { value: weighted / total, sumP: total, openSet, p, missing: null };
}

/**
 * E at each mark: missing at or after the first outcome's close, when no outcome is open, when an
 * open outcome has no probability (a collection gap first), or when Σp is out of range.
 */
export function expectedAt(outcomes: Outcome[], marks: number[]): ExpectedMark[] {
  const firstClose = Math.min(...outcomes.map((o) => o.history.closeTime));
  // In ticker order, as the study sums them and names the first reason.
  const sorted = [...outcomes].sort((a, b) => (a.history.ticker < b.history.ticker ? -1 : a.history.ticker > b.history.ticker ? 1 : 0));
  return marks.map((t) => {
    const open = sorted.filter((o) => o.history.openTime <= t && t < o.history.closeTime);
    if (t >= firstClose) return { t, value: null, sumP: null, openSet: [], p: null, missing: "after_close" };
    if (open.length === 0) return { t, value: null, sumP: null, openSet: [], p: null, missing: "not_open" };
    return { t, ...combine(open.map((o) => o.history), open.map((o) => o.at(t))) };
  });
}

/** Every top-of-hour mark in [from, to]. */
export function hourlyMarks(from: number, to: number): number[] {
  const marks: number[] = [];
  for (let t = Math.ceil(from / HOUR_MS) * HOUR_MS; t <= to; t += HOUR_MS) marks.push(t);
  return marks;
}
