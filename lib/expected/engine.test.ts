import { describe, expect, it } from "vitest";
import {
  combine,
  covered,
  estimate,
  expectedAt,
  hourlyMarks,
  LOOKBACK_MS,
  mergeRanges,
  Outcome,
  type OutcomeCandle,
  type OutcomeHistory,
} from "./engine";
import { gapsIn, liveOutcome, storedOutcome, withLive } from "./history";

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const T0 = Date.UTC(2026, 8, 1, 14);
const h = (n: number) => T0 + n * HOUR;

function outcome(over: Partial<OutcomeHistory> & { candles?: OutcomeCandle[] }): Outcome {
  return new Outcome({
    ticker: "X-H0",
    value: 0,
    openTime: h(-1000),
    closeTime: h(1000),
    candles: [],
    covered: [{ from: h(-1000), to: h(1000) }],
    seed: null,
    ...over,
  });
}

describe("estimate", () => {
  it("applies rules 1–3", () => {
    expect(estimate(0.4, 0.44)).toEqual({ p: 0.42000000000000004, rule: 1 });
    expect(estimate(0.4, 0.4)).toEqual({ p: 0.4, rule: 1 });
    expect(estimate(null, 0.1)).toEqual({ p: 0.05, rule: 2 });
    expect(estimate(0.9, null)).toEqual({ p: 0.95, rule: 3 });
  });

  it("counts a crossed book, a bid of 0, and an ask of $1 as no usable quote", () => {
    expect(estimate(0.5, 0.4)).toEqual({ p: null, rule: "crossed" });
    expect(estimate(0, 1)).toEqual({ p: null, rule: 4 });
    expect(estimate(null, null)).toEqual({ p: null, rule: 4 });
    // A bid of 0 is no bid; an ask of $1 is no ask.
    expect(estimate(0, 0.1)).toEqual({ p: 0.05, rule: 2 });
    expect(estimate(0.9, 1)).toEqual({ p: 0.95, rule: 3 });
  });
});

describe("Outcome.at", () => {
  it("uses the latest candle at or before the mark", () => {
    const o = outcome({ candles: [{ endTs: h(0), bid: 0.2, ask: 0.3 }, { endTs: h(2), bid: 0.4, ask: 0.5 }] });
    expect(o.at(h(1))).toEqual({ p: 0.25, rule: 1 });
    expect(o.at(h(2))).toEqual({ p: 0.45, rule: 1 });
  });

  it("counts a candle as recent only if it ended strictly less than 7 days before the mark", () => {
    const o = outcome({ candles: [{ endTs: h(0), bid: 0.2, ask: 0.3 }] });
    expect(o.at(h(0) + LOOKBACK_MS - HOUR)).toEqual({ p: 0.25, rule: 1 });
    // Exactly 7 days: no longer recent, so rule 4 on its last estimate (25¢): stale.
    expect(o.at(h(0) + LOOKBACK_MS)).toEqual({ p: null, rule: "stale_quote" });
  });

  it("rule 4: 0 if the last usable estimate was at most 5¢ or there never was one, else stale", () => {
    const quiet = (bid: number, ask: number) => outcome({ candles: [{ endTs: h(0), bid, ask }, { endTs: h(1), bid: 0, ask: 1 }] });
    expect(quiet(0.04, 0.06).at(h(2))).toEqual({ p: 0, rule: "4_zero" });
    expect(quiet(0.04, 0.07).at(h(2))).toEqual({ p: null, rule: "stale_quote" });
    expect(outcome({ candles: [{ endTs: h(1), bid: 0, ask: 1 }] }).at(h(2))).toEqual({ p: 0, rule: "4_zero" });
    expect(outcome({}).at(h(2))).toEqual({ p: 0, rule: "4_zero" });
    // A crossed book is no usable quote either.
    expect(outcome({ candles: [{ endTs: h(0), bid: 0.3, ask: 0.2 }] }).at(h(1))).toEqual({ p: 0, rule: "4_zero" });
  });

  it("rule 4 uses the seed: a known one like any estimate, an unknown one as incomplete history", () => {
    const silent = [{ endTs: h(0), bid: 0, ask: 1 }];
    expect(outcome({ candles: silent, seed: 0.03 }).at(h(1))).toEqual({ p: 0, rule: "4_zero" });
    expect(outcome({ candles: silent, seed: 0.3 }).at(h(1))).toEqual({ p: null, rule: "stale_quote" });
    expect(outcome({ candles: silent, seed: null }).at(h(1))).toEqual({ p: 0, rule: "4_zero" });
    expect(outcome({ candles: silent, seed: "unknown" }).at(h(1))).toEqual({ p: null, rule: "history_incomplete" });
    expect(outcome({ seed: "unknown" }).at(h(1))).toEqual({ p: null, rule: "history_incomplete" });
    // A usable quote in the loaded candles replaces an unknown seed.
    const later = outcome({ candles: [{ endTs: h(0), bid: 0.01, ask: 0.03 }, { endTs: h(1), bid: 0, ask: 1 }], seed: "unknown" });
    expect(later.at(h(2))).toEqual({ p: 0, rule: "4_zero" });
  });

  it("needs coverage from the latest candle, or the last 7 days, to the mark", () => {
    const candles = [{ endTs: h(0), bid: 0.2, ask: 0.3 }];
    // Covered through h(5) (exclusive): marks up to h(4) are fine.
    const o = outcome({ candles, covered: [{ from: h(-10), to: h(5) }] });
    expect(o.at(h(4))).toEqual({ p: 0.25, rule: 1 });
    expect(o.at(h(5))).toEqual({ p: null, rule: "coverage" });
    // Without a recent candle, the last 7 days (or since the open) must be covered.
    const none = outcome({ openTime: h(-2), covered: [{ from: h(-1), to: h(10) }] });
    expect(none.at(h(5))).toEqual({ p: 0, rule: "4_zero" });
    expect(outcome({ covered: [{ from: h(-1), to: h(10) }] }).at(h(5))).toEqual({ p: null, rule: "coverage" });
  });
});

describe("covered and mergeRanges", () => {
  it("checks every hourly end in (after, upto] inside one range", () => {
    expect(covered([], h(3), h(3))).toBe(true);
    expect(covered([], h(3) + 1, h(4) - 1)).toBe(true);
    expect(covered([{ from: h(4), to: h(6) }], h(3), h(5))).toBe(true);
    expect(covered([{ from: h(4), to: h(5) }], h(3), h(5))).toBe(false);
    expect(covered([{ from: h(4), to: h(5) }, { from: h(5), to: h(7) }], h(3), h(6))).toBe(false);
    expect(covered(mergeRanges([{ from: h(5), to: h(7) }, { from: h(4), to: h(5) }]), h(3), h(6))).toBe(true);
  });

  it("joins touching and overlapping ranges", () => {
    expect(mergeRanges([{ from: 5, to: 7 }, { from: 0, to: 2 }, { from: 2, to: 3 }, { from: 6, to: 9 }])).toEqual([
      { from: 0, to: 3 },
      { from: 5, to: 9 },
    ]);
  });
});

describe("expectedAt", () => {
  const a = (over: Partial<OutcomeHistory>) => outcome({ ticker: "E-C25", value: -25, ...over });
  const b = (over: Partial<OutcomeHistory>) => outcome({ ticker: "E-H0", value: 0, ...over });
  const c = (over: Partial<OutcomeHistory>) => outcome({ ticker: "E-H25", value: 25, ...over });
  const book = (p: number) => [{ endTs: h(0), bid: p - 0.01, ask: p + 0.01 }];

  it("is Σp·v / Σp over the open outcomes", () => {
    const [m] = expectedAt([a({ candles: book(0.2) }), b({ candles: book(0.7) }), c({ candles: book(0.1) })], [h(1)]);
    expect(m.value).toBeCloseTo((0.2 * -25 + 0.1 * 25) / 1.0, 12);
    expect(m.sumP).toBeCloseTo(1, 12);
    expect(m.openSet).toEqual(["E-C25", "E-H0", "E-H25"]);
    expect(m.missing).toBeNull();
  });

  it("renormalizes over the outcomes open at the mark only", () => {
    const outcomes = [a({ candles: book(0.3) }), b({ candles: book(0.7) }), c({ candles: book(0.5), openTime: h(2) })];
    const [before, after] = expectedAt(outcomes, [h(1), h(2)]);
    expect(before.value).toBeCloseTo((0.3 * -25) / 1.0, 12);
    expect(before.openSet).toEqual(["E-C25", "E-H0"]);
    // Σp = 1.5 once the third opens: out of range.
    expect(after).toMatchObject({ value: null, missing: "sum_out_of_range", openSet: ["E-C25", "E-H0", "E-H25"] });
    expect(after.sumP).toBeCloseTo(1.5, 12);
  });

  it("accepts Σp at exactly 0.80 and 1.20, and nothing outside", () => {
    // Midpoints of exact cents, so the sums are exact in binary only where they are below.
    const at = (p1: number, p2: number) => combine([{ ticker: "E-C25", value: -25 }, { ticker: "E-H0", value: 0 }], [{ p: p1, rule: 1 }, { p: p2, rule: 1 }]);
    expect(at(0.5, 0.3)).toMatchObject({ missing: null, sumP: 0.8 });
    expect(at(0.5, 0.7)).toMatchObject({ missing: null, sumP: 1.2 });
    expect(at(0.5, 0.29)).toMatchObject({ missing: "sum_out_of_range", value: null });
    expect(at(0.5, 0.71)).toMatchObject({ missing: "sum_out_of_range", value: null });
  });

  it("is missing at and after the first close, and when nothing is open", () => {
    const outcomes = [a({ candles: book(0.9), closeTime: h(3) }), b({ candles: book(0.2), closeTime: h(4), openTime: h(2) })];
    const marks = expectedAt(outcomes, [h(1), h(2), h(3), h(4)]);
    expect(marks[0]).toMatchObject({ value: -25, openSet: ["E-C25"] });
    expect(marks[1].value).toBeCloseTo((0.9 * -25) / 1.1, 12);
    expect(marks.slice(2).map((m) => m.missing)).toEqual(["after_close", "after_close"]);
    const late = [a({ openTime: h(5) }), b({ openTime: h(5) })];
    expect(expectedAt(late, [h(1)])[0]).toMatchObject({ value: null, missing: "not_open", openSet: [] });
  });

  it("tells a collection gap from an empty book, and puts the gap first", () => {
    const gap = { covered: [{ from: h(-1000), to: h(1) }] };
    const stale = [{ endTs: h(0), bid: 0, ask: 1 }];
    // A stale quote on one outcome (in ticker order, first) and a gap on another: coverage wins.
    const marks = expectedAt([a({ candles: stale, seed: 0.4 }), b({ candles: book(0.7), ...gap })], [h(2)]);
    expect(marks[0]).toMatchObject({ value: null, missing: "coverage" });
    // Without the gap, the stale quote is the reason.
    expect(expectedAt([a({ candles: stale, seed: 0.4 }), b({ candles: book(0.7) })], [h(2)])[0].missing).toBe("stale_quote");
    // An empty book that was never quoted counts as 0, not missing.
    expect(expectedAt([a({ candles: stale }), b({ candles: book(0.9) })], [h(2)])[0]).toMatchObject({ value: 0, missing: null });
  });

  it("names the first missing reason in ticker order, whatever order the outcomes come in", () => {
    const outcomes = [b({ seed: "unknown" }), a({ candles: [{ endTs: h(0), bid: 0, ask: 1 }], seed: 0.4 })];
    expect(expectedAt(outcomes, [h(1)])[0].missing).toBe("stale_quote");
  });
});

describe("histories", () => {
  const meta = { ticker: "E-H0", value: 0, openTime: h(-100), closeTime: h(100) };

  it("finds the parts of a range no coverage includes", () => {
    expect(gapsIn([], { from: 0, to: 10 })).toEqual([{ from: 0, to: 10 }]);
    expect(gapsIn([{ from: 2, to: 4 }, { from: 6, to: 12 }], { from: 0, to: 10 })).toEqual([
      { from: 0, to: 2 },
      { from: 4, to: 6 },
    ]);
    expect(gapsIn([{ from: -5, to: 20 }], { from: 0, to: 10 })).toEqual([]);
  });

  it("builds a stored outcome, with no seed meaning never quoted", () => {
    const stored = { candles: new Map([["E-H0", book()]]), seeds: new Map<string, number>(), covered: new Map([["E-H0", [{ from: h(-100), to: h(5) }]]]) };
    expect(storedOutcome(meta, stored)).toMatchObject({ seed: null, candles: book(), covered: [{ from: h(-100), to: h(5) }] });
  });

  it("adds a live tail: live candles win, and the fetched window counts as covered", () => {
    const stored = { ...meta, candles: book(), covered: [{ from: h(-100), to: h(1) }], seed: 0.2 };
    const tail = withLive(stored, [{ endTs: h(0), bid: 0.5, ask: 0.6 }, { endTs: h(3), bid: 0.6, ask: 0.7 }], { from: h(-1), to: h(4) });
    expect(tail.candles).toEqual([{ endTs: h(0), bid: 0.5, ask: 0.6 }, { endTs: h(3), bid: 0.6, ask: 0.7 }]);
    expect(tail.covered).toEqual([{ from: h(-100), to: h(4) + 1 }]);
    expect(tail.seed).toBe(0.2);
    expect(new Outcome(tail).at(h(4))).toEqual({ p: 0.6499999999999999, rule: 1 });
  });

  it("marks live-only history before the window as unknown, unless the window starts at the open", () => {
    expect(liveOutcome(meta, [], { from: h(-50), to: h(10) }).seed).toBe("unknown");
    expect(liveOutcome(meta, [], { from: h(-100), to: h(10) }).seed).toBeNull();
    expect(liveOutcome({ ...meta, openTime: null }, [], { from: h(-100), to: h(10) }).seed).toBe("unknown");
  });

  function book(): OutcomeCandle[] {
    return [{ endTs: h(0), bid: 0.2, ask: 0.3 }];
  }
});

describe("hourlyMarks", () => {
  it("lists every top of the hour in the range, ends included", () => {
    expect(hourlyMarks(h(0) - 1, h(2))).toEqual([h(0), h(1), h(2)]);
    expect(hourlyMarks(h(0) + 1, h(1) - 1)).toEqual([]);
    expect(hourlyMarks(h(0), h(0) + 3 * DAY)).toHaveLength(73);
  });
});
