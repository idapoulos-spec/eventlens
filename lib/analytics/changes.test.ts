import { describe, expect, it } from "vitest";
import { computeChanges } from "./changes";
import type { ResearchRow, RowExclusion } from "./research";

/** Hourly-style rows: [step, stock close, probability, exclusion]. */
function rows(...specs: [number, number, number | null, RowExclusion | null][]): ResearchRow[] {
  return specs.map(([step, stockClose, probability, exclusion]) => ({
    t: step * 1000,
    step,
    stockClose,
    probability,
    kalshiSource: probability === null ? null : "midpoint",
    kalshiAsOf: probability === null ? null : step * 1000,
    exclusion,
  }));
}

describe("computeChanges", () => {
  it("measures probability changes in pp and log returns between consecutive usable rows", () => {
    const { changes, excluded } = computeChanges(rows([1, 100, 0.4, null], [2, 110, 0.45, null], [3, 99, 0.45, null]));
    expect(changes).toHaveLength(2);
    expect(changes[0]).toMatchObject({ t: 2000, step: 2 });
    expect(changes[0].probChangePp).toBeCloseTo(5, 10);
    expect(changes[0].logReturn).toBeCloseTo(Math.log(1.1), 12);
    expect(changes[1].probChangePp).toBe(0);
    expect(changes[1].logReturn).toBeCloseTo(Math.log(0.9), 12);
    expect(excluded).toEqual({});
  });

  it("leaves out intervals that span time the stock wasn't trading", () => {
    // Steps 3 → 21: the stock closed at step 3 and reopened at step 21 (overnight).
    const { changes, excluded, intervals } = computeChanges(rows([2, 100, 0.4, null], [3, 101, 0.42, null], [21, 105, 0.6, null], [22, 106, 0.61, null]));
    expect(changes.map((c) => c.step)).toEqual([3, 22]);
    expect(excluded).toEqual({ non_trading: 1 });
    // The excluded interval's values are still reported, for the CSV.
    expect(intervals[2].exclusion).toBe("non_trading");
    expect(intervals[2].probChangePp).toBeCloseTo(18, 10);
    expect(intervals[2].logReturn).toBeCloseTo(Math.log(105 / 101), 12);
  });

  it("leaves out intervals that start or end at a row with an unusable Kalshi value", () => {
    const { changes, excluded } = computeChanges(
      rows([1, 100, null, "before_kalshi"], [2, 100, 0.4, null], [3, 100, 0.5, "kalshi_last_price"], [4, 100, 0.52, null], [5, 100, 0.53, null]),
    );
    expect(changes.map((c) => c.step)).toEqual([5]);
    expect(excluded).toEqual({ before_kalshi: 1, kalshi_last_price: 2 });
  });

  it("returns one interval per row, the first with nothing to compare against", () => {
    const { intervals } = computeChanges(rows([1, 100, 0.4, null], [2, 101, 0.41, null]));
    expect(intervals).toHaveLength(2);
    expect(intervals[0]).toEqual({ t: 1000, step: 1, probChangePp: null, logReturn: null, exclusion: "first_row" });
    expect(intervals[1].exclusion).toBeNull();
  });

  it("returns nothing for no rows", () => {
    expect(computeChanges([])).toEqual({ intervals: [], changes: [], excluded: {} });
  });
});
