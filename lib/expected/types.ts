// What an event analysis hands the page: the event, each outcome, E now and over time, and where
// the history came from. Plain data, so server sections can pass it to client charts.

import type { Provenance, ResearchWindow } from "@/lib/history/types";
import type { MarketPhase } from "@/lib/kalshi/status";
import type { ExpectedMark, ExpectedMissing, OutcomeMissing, Rule } from "./engine";
import type { EventProblem, MappedBy, UnmappedReason } from "./mapping";

/** How an outcome's current probability was found, or why it has none. */
export type CurrentRule = Rule | "4_zero" | OutcomeMissing | "not_open";

export interface EventOutcome {
  ticker: string;
  /** The YES label, e.g. "Cut 25bps"; the ticker if Kalshi gave none. */
  label: string;
  /** Basis points (or the series' unit), or null if the outcome couldn't be mapped. */
  value: number | null;
  mappedBy: MappedBy | null;
  suffix: "agrees" | "irregular" | null;
  unmapped: UnmappedReason | null;
  phase: MarketPhase;
  /** "yes" or "no" once settled. */
  result: string | null;
  openTime: number | null;
  closeTime: number | null;
  /** The live book, in dollars; null when the event isn't open. */
  bid: number | null;
  ask: number | null;
  /** The outcome's probability now (open events) or at the last mark before the close. */
  p: number | null;
  rule: CurrentRule | null;
  /** p / Σp, when E has a value. */
  weight: number | null;
}

/** E at one moment, or why it's missing. */
export interface ExpectedNow {
  t: number;
  value: number | null;
  sumP: number | null;
  openSet: string[];
  missing: ExpectedMissing | "unmapped" | null;
}

/** ΔE against the hourly mark at or before a lookback, or why there's none. */
export interface ExpectedChange {
  value: number | null;
  /** The mark compared against. */
  from: number | null;
  unavailable: "no_current" | "no_reference" | "outcome_set_changed" | null;
}

/** A point of a chart sent to the browser: only marks where something changed. Null is a gap. */
export interface ChartPoint {
  t: number;
  value: number | null;
}

/**
 * Each mapped outcome's share of Σp at a mark, in EventAnalysis.outcomes' order (0 for one that
 * isn't open), rounded to 0.01%; null where E is missing.
 */
export interface WeightPoint {
  t: number;
  weights: number[] | null;
}

export interface EventAnalysis {
  ticker: string;
  title: string;
  subtitle: string | null;
  /** The series' unit and what E is, e.g. "bp" and "the expected rate change". */
  unit: string;
  label: string;
  /** Kalshi's flag; null if unknown (a stored event read without Kalshi). */
  mutuallyExclusive: boolean | null;
  /** Why no outcome mapping exists for the whole event, if so. */
  problem: EventProblem | null;
  /** Every outcome, by value (unmapped ones last). */
  outcomes: EventOutcome[];
  /** "open" while any outcome trades; otherwise the earliest phase among them. */
  phase: MarketPhase;
  /** The first outcome's close (ms): E is only defined before it. */
  firstClose: number | null;
  /** The outcome that resolved YES, once settled. */
  decided: { ticker: string; label: string } | null;
  /** E from the live books (open events), or at the last mark before the close. */
  current: ExpectedNow | null;
  change1h: ExpectedChange;
  change24h: ExpectedChange;
  /** E at every top of the hour in the window, oldest first (used on the server: Research). */
  marks: ExpectedMark[];
  /** E for the history chart: marks where it changed, and the last one. */
  chart: ChartPoint[];
  /** Weights for the outcome-probability chart, likewise. */
  weights: WeightPoint[];
  window: ResearchWindow;
  /** Marks run from here (ms) to `to`: the 90 days Research and the charts use. */
  from: number;
  to: number;
  provenance: Provenance;
  /** Why some or all of the history is missing, if it failed to load. */
  historyError: string | null;
  fetchedAt: number;
}
