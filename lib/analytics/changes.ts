import type { ResearchRow, RowExclusion } from "./research";

/** Why the interval ending at a row is left out of the analysis. */
export type IntervalExclusion =
  /** The first row in the window has no earlier row to compare with. */
  | "first_row"
  /**
   * The previous row isn't the previous slot on the grid: the interval spans time the
   * stock doesn't trade (overnight, a weekend, a holiday, a halt) or a missing bar.
   */
  | "non_trading"
  /** An event's open outcomes differ between the two ends, so E's change mixes in a new outcome. */
  | "outcome_set_changed"
  | RowExclusion;

/** The interval between two consecutive rows, ending at `t`. */
export interface RowInterval {
  t: number;
  step: number;
  /** Change in Kalshi's value (a probability in pp, or an expected value in its unit), when both ends have one. */
  kalshiChange: number | null;
  /** Stock log return ln(S₁/S₀); null for the first row. */
  logReturn: number | null;
  exclusion: IntervalExclusion | null;
}

/** A usable interval: both ends are real observations one grid slot apart. */
export interface ChangePoint {
  t: number;
  step: number;
  kalshiChange: number;
  logReturn: number;
}

export interface ChangeSeries {
  /** One entry per row, in the same order. */
  intervals: RowInterval[];
  changes: ChangePoint[];
  /** How many intervals were left out, by reason (not counting the first row). */
  excluded: Partial<Record<Exclusion, number>>;
}

type Exclusion = Exclude<IntervalExclusion, "first_row">;

/**
 * Kalshi changes and stock log returns between consecutive rows. An interval counts only if
 * both ends have a usable Kalshi value and the rows are one grid slot apart, so no change spans
 * hours the stock wasn't trading; for an event's expected value, its open outcomes must also be
 * the same at both ends. `scale` converts a change in the rows' values to its unit (KalshiVariable):
 * 100 turns probabilities into pp.
 */
export function computeChanges(rows: ResearchRow[], scale: number): ChangeSeries {
  const intervals: RowInterval[] = [];
  const changes: ChangePoint[] = [];
  const excluded: Partial<Record<Exclusion, number>> = {};

  rows.forEach((row, i) => {
    const prev = i > 0 ? rows[i - 1] : null;
    const sameOutcomes = prev?.expected === undefined || row.expected === undefined || prev.expected.openSet === row.expected.openSet;
    const kalshiChange =
      prev?.kalshiValue != null && row.kalshiValue !== null && sameOutcomes ? (row.kalshiValue - prev.kalshiValue) * scale : null;
    const logReturn = prev ? Math.log(row.stockClose / prev.stockClose) : null;
    const exclusion: IntervalExclusion | null =
      prev === null
        ? "first_row"
        : row.step - prev.step !== 1
          ? "non_trading"
          : (prev.exclusion ?? row.exclusion ?? (sameOutcomes ? null : "outcome_set_changed"));

    intervals.push({ t: row.t, step: row.step, kalshiChange, logReturn, exclusion });
    if (exclusion === null && kalshiChange !== null && logReturn !== null) {
      changes.push({ t: row.t, step: row.step, kalshiChange, logReturn });
    } else if (exclusion !== null && exclusion !== "first_row") {
      excluded[exclusion] = (excluded[exclusion] ?? 0) + 1;
    }
  });

  return { intervals, changes, excluded };
}
