// An event analysis from its outcomes' histories: E now, ΔE over an hour and a day, each outcome's
// row, and the charts' points. Pure, so it's tested without a network or a database.

import { marketPhase, type MarketPhase } from "@/lib/kalshi/status";
import { combine, estimate, type ExpectedMark, Outcome, type OutcomeState } from "./engine";
import type { EventMapping } from "./mapping";
import type { ChartPoint, CurrentRule, EventOutcome, ExpectedChange, ExpectedNow, WeightPoint } from "./types";

const HOUR_MS = 60 * 60 * 1000;

/** An outcome market's book and status, in dollars. */
export interface OutcomeBook {
  ticker: string;
  label: string | null;
  status: string;
  result: string | null;
  openTime: number | null;
  closeTime: number | null;
  bid: number | null;
  ask: number | null;
}

const byTicker = (a: Outcome, b: Outcome) => (a.history.ticker < b.history.ticker ? -1 : a.history.ticker > b.history.ticker ? 1 : 0);

/**
 * E from the live books at `t`, by the same rules as at the marks: an outcome without a usable
 * quote counts as 0 if its last estimate was at most 5¢, and is stale otherwise.
 */
export function currentExpected(
  outcomes: Outcome[],
  books: Map<string, { bid: number | null; ask: number | null }>,
  t: number,
): { now: ExpectedNow; states: Map<string, OutcomeState> } {
  const states = new Map<string, OutcomeState>();
  const firstClose = Math.min(...outcomes.map((o) => o.history.closeTime));
  const open = outcomes.filter((o) => o.history.openTime <= t && t < o.history.closeTime).sort(byTicker);
  if (t >= firstClose) return { now: { t, value: null, sumP: null, openSet: [], missing: "after_close" }, states };
  if (open.length === 0) return { now: { t, value: null, sumP: null, openSet: [], missing: "not_open" }, states };
  for (const o of open) {
    const book = books.get(o.history.ticker);
    const e = estimate(book?.bid ?? null, book?.ask ?? null);
    states.set(o.history.ticker, e.p !== null ? { p: e.p, rule: e.rule } : o.silent(o.lastUsableAt(t)));
  }
  const { value, sumP, openSet, missing } = combine(
    open.map((o) => o.history),
    open.map((o) => states.get(o.history.ticker)!),
  );
  return { now: { t, value, sumP, openSet, missing }, states };
}

/** ΔE from the hourly mark at or before `t − lookback` to `current`; only across the same open outcomes. */
export function changeSince(current: ExpectedNow | null, marks: ExpectedMark[], lookbackMs: number): ExpectedChange {
  if (current?.value == null) return { value: null, from: null, unavailable: "no_current" };
  const from = Math.floor((current.t - lookbackMs) / HOUR_MS) * HOUR_MS;
  const ref = marks.find((m) => m.t === from);
  if (!ref || ref.value === null) return { value: null, from, unavailable: "no_reference" };
  if (ref.openSet.join(" ") !== current.openSet.join(" ")) return { value: null, from, unavailable: "outcome_set_changed" };
  return { value: current.value - ref.value, from, unavailable: null };
}

/** The marks where a series changes, and the last mark of each run, so steps and gaps draw as they are. */
function runs<T>(marks: ExpectedMark[], key: (m: ExpectedMark) => string, point: (m: ExpectedMark) => T): T[] {
  const keys = marks.map(key);
  return marks.filter((_, i) => i === 0 || i === marks.length - 1 || keys[i] !== keys[i - 1] || keys[i] !== keys[i + 1]).map(point);
}

/** E for its chart, to 0.001 (finer than the chart shows): only marks where that changes, and each run's last. */
export function chartPoints(marks: ExpectedMark[]): ChartPoint[] {
  const value = (m: ExpectedMark) => (m.value === null ? null : Number(m.value.toFixed(3)));
  return runs(
    marks,
    (m) => String(value(m)),
    (m) => ({ t: m.t, value: value(m) }),
  );
}

/** Each of `tickers`' share of Σp to 0.01%, for the outcome-probability chart; likewise only where it changes. */
export function weightPoints(marks: ExpectedMark[], tickers: string[]): WeightPoint[] {
  const weightsOf = (m: ExpectedMark): number[] | null => {
    if (m.value === null || m.p === null || m.sumP === null) return null;
    return tickers.map((ticker) => {
      const i = m.openSet.indexOf(ticker);
      return i === -1 ? 0 : Number((m.p![i] / m.sumP!).toFixed(4));
    });
  };
  return runs(
    marks,
    (m) => JSON.stringify(weightsOf(m)),
    (m) => ({ t: m.t, weights: weightsOf(m) }),
  );
}

/** "open" while any outcome trades; otherwise the least advanced phase among them. */
export function eventPhase(books: OutcomeBook[]): MarketPhase {
  const phases = books.map((b) => marketPhase(b.status));
  if (phases.includes("open")) return "open";
  if (phases.length > 0 && phases.every((p) => p === "settled")) return "settled";
  return phases.some((p) => p === "closed" || p === "settled") ? "closed" : "not_trading";
}

/**
 * Each outcome's row: what it's worth and how that was read, its book, and its probability and
 * weight at `current` (from `states` when live, else from the mark `current` came from).
 */
export function outcomeRows(
  books: OutcomeBook[],
  mapping: EventMapping,
  current: ExpectedNow | null,
  states: Map<string, OutcomeState>,
  mark: ExpectedMark | null,
  live: boolean,
): EventOutcome[] {
  const mapped = new Map(mapping.outcomes.map((o) => [o.ticker, o]));
  const unmapped = new Map(mapping.unmapped.map((u) => [u.ticker, u.reason]));
  const rows = books.map((b): EventOutcome => {
    const m = mapped.get(b.ticker);
    let p: number | null = null;
    let rule: CurrentRule | null = null;
    const state = states.get(b.ticker);
    if (state) {
      p = state.p;
      rule = state.rule;
    } else if (mark?.p && mark.openSet.includes(b.ticker)) {
      p = mark.p[mark.openSet.indexOf(b.ticker)];
    } else if (current && !current.openSet.includes(b.ticker) && current.openSet.length > 0) {
      rule = "not_open";
    }
    return {
      ticker: b.ticker,
      label: b.label || b.ticker,
      value: m?.value ?? null,
      mappedBy: m?.mappedBy ?? null,
      suffix: m?.suffix ?? null,
      unmapped: unmapped.get(b.ticker) ?? null,
      phase: marketPhase(b.status),
      result: b.result,
      openTime: b.openTime,
      closeTime: b.closeTime,
      bid: live ? b.bid : null,
      ask: live ? b.ask : null,
      p,
      rule,
      weight: current?.value != null && current.sumP && p !== null ? p / current.sumP : null,
    };
  });
  // By value, cuts first; unmapped outcomes last, by ticker.
  return rows.sort((a, b) => (a.value ?? Infinity) - (b.value ?? Infinity) || (a.ticker < b.ticker ? -1 : 1));
}

/** The last mark with a value, for an event that has closed: E just before the close. */
export function lastValid(marks: ExpectedMark[]): ExpectedMark | null {
  for (let i = marks.length - 1; i >= 0; i--) if (marks[i].value !== null) return marks[i];
  return null;
}
