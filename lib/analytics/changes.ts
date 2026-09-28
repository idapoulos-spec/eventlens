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
  | RowExclusion;

/** The interval between two consecutive rows, ending at `t`. */
export interface RowInterval {
  t: number;
  step: number;
  /** Kalshi probability change in percentage points, when both ends have a probability. */
  probChangePp: number | null;
  /** Stock log return ln(S₁/S₀); null for the first row. */
  logReturn: number | null;
  exclusion: IntervalExclusion | null;
}

/** A usable interval: both ends are real observations one grid slot apart. */
export interface ChangePoint {
  t: number;
  step: number;
  probChangePp: number;
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
 * Kalshi probability changes (pp) and stock log returns between consecutive rows.
 * An interval counts only if both ends have a usable Kalshi value and the rows are one
 * grid slot apart, so no change spans hours the stock wasn't trading.
 */
export function computeChanges(rows: ResearchRow[]): ChangeSeries {
  const intervals: RowInterval[] = [];
  const changes: ChangePoint[] = [];
  const excluded: Partial<Record<Exclusion, number>> = {};

  rows.forEach((row, i) => {
    const prev = i > 0 ? rows[i - 1] : null;
    const probChangePp =
      prev?.probability != null && row.probability !== null ? (row.probability - prev.probability) * 100 : null;
    const logReturn = prev ? Math.log(row.stockClose / prev.stockClose) : null;
    const exclusion: IntervalExclusion | null =
      prev === null
        ? "first_row"
        : row.step - prev.step !== 1
          ? "non_trading"
          : (prev.exclusion ?? row.exclusion);

    intervals.push({ t: row.t, step: row.step, probChangePp, logReturn, exclusion });
    if (exclusion === null && probChangePp !== null && logReturn !== null) {
      changes.push({ t: row.t, step: row.step, probChangePp, logReturn });
    } else if (exclusion !== null && exclusion !== "first_row") {
      excluded[exclusion] = (excluded[exclusion] ?? 0) + 1;
    }
  });

  return { intervals, changes, excluded };
}
