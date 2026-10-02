import { describe, expect, it } from "vitest";
import { computeChanges } from "./changes";
import { eventStudy, eventWindowRows } from "./event-study";
import type { ResearchRow } from "./research";

/** Consecutive rows (one grid slot apart) with the given stock closes and probabilities. */
function rows(closes: number[], probabilities: number[]): ResearchRow[] {
  return closes.map((stockClose, i) => ({
    t: (i + 1) * 1000,
    step: i + 1,
    stockClose,
    probability: probabilities[i],
    kalshiSource: "midpoint",
    kalshiAsOf: (i + 1) * 1000,
    exclusion: null,
  }));
}

const study = (r: ResearchRow[], thresholdPp: number, before = 3, after = 3) =>
  eventStudy(r, computeChanges(r).changes, { thresholdPp, before, after });

describe("eventStudy", () => {
  it("averages the stock path around a jump, starting from the close before it", () => {
    // The probability jumps 40% → 45% during bar 10, and the stock steps up 10% in the same bar.
    const closes = Array.from({ length: 20 }, (_, i) => (i < 10 ? 100 : 110));
    const probs = Array.from({ length: 20 }, (_, i) => (i < 10 ? 0.4 : 0.45));
    const result = study(rows(closes, probs), 5);

    expect(result.offsets).toEqual([-3, -2, -1, 0, 1, 2, 3]);
    expect(result.detected).toBe(1);
    expect(result.rises.n).toBe(1);
    expect(result.rises.events).toEqual([{ t: 11_000, probChangePp: expect.closeTo(5, 10) }]);
    const up = Math.log(1.1) * 100;
    expect(result.rises.mean!.map((v) => Number(v.toFixed(10)))).toEqual([0, 0, 0, up, up, up, up].map((v) => Number(v.toFixed(10))));
    expect(result.falls).toMatchObject({ n: 0, mean: null, flag: "insufficient" });
    expect(result.rises.flag).toBe("small");
  });

  it("keeps rises and falls apart", () => {
    const probs = Array.from({ length: 30 }, (_, i) => (i < 8 ? 0.5 : i < 20 ? 0.6 : 0.45));
    const result = study(rows(Array(30).fill(100), probs), 5);
    expect(result.rises.events.map((e) => e.t)).toEqual([9_000]);
    expect(result.falls.events.map((e) => e.t)).toEqual([21_000]);
  });

  it("counts a move of exactly the threshold despite floating-point rounding", () => {
    const probs = Array.from({ length: 12 }, (_, i) => (i < 6 ? 0.495 : 0.515));
    expect(study(rows(Array(12).fill(100), probs), 2).detected).toBe(1);
    expect(study(rows(Array(12).fill(100), probs), 2.5).detected).toBe(0);
  });

  it("skips jumps too close to the data's edges or to an earlier jump", () => {
    // Jumps during bars 1 (too early), 7, 9 (within 3 bars of 7), and 18 (too late).
    const probs = [0.3, 0.4, 0.4, 0.4, 0.4, 0.4, 0.4, 0.5, 0.5, 0.6, 0.6, 0.6, 0.6, 0.6, 0.6, 0.6, 0.6, 0.6, 0.7, 0.7];
    const result = study(rows(Array(20).fill(100), probs), 5);
    expect(result.detected).toBe(4);
    expect(result.rises.events.map((e) => e.t)).toEqual([8_000]);
    expect(result.skippedOverlap).toBe(1);
    expect(result.skippedEdge).toBe(2);
  });

  it("shows the stock's normal drift as a baseline over every full window", () => {
    // A steady 0.1% per bar: every window climbs 0.1 percentage points per bar.
    const closes = Array.from({ length: 20 }, (_, i) => 100 * Math.exp(0.001 * i));
    const result = study(rows(closes, Array(20).fill(0.5)), 5);
    expect(result.baseline.n).toBe(20 - 3 - 3);
    result.baseline.mean!.forEach((v, k) => expect(v).toBeCloseTo((result.offsets[k] + 1) * 0.1, 10));
  });

  it("averages the baseline over windows anchored after a regular interval only", () => {
    const r = rows(Array.from({ length: 12 }, (_, i) => 100 + i), Array(12).fill(0.5));
    // A gap (e.g. overnight) before row 6: windows that anchor on it are left out.
    for (const row of r.slice(6)) row.step += 17;
    const result = study(r, 5, 2, 2);
    expect(result.baseline.n).toBe(12 - 2 - 2 - 1);
    const expected = [2, 3, 4, 5, 7, 8, 9].map((i) => Math.log(r[i + 2].stockClose / r[i - 1].stockClose) * 100);
    expect(result.baseline.mean!.at(-1)).toBeCloseTo(expected.reduce((a, b) => a + b, 0) / expected.length, 10);
  });

  it("has no baseline when the data is shorter than one window", () => {
    expect(study(rows([100, 101, 102], [0.5, 0.5, 0.5]), 5).baseline).toEqual({ mean: null, n: 0 });
  });

  it("studies another log-change series when given one, skipping windows it can't measure", () => {
    const closes = Array.from({ length: 20 }, (_, i) => (i < 10 ? 100 : 110));
    const probs = Array.from({ length: 20 }, (_, i) => (i < 10 ? 0.4 : 0.45));
    const r = rows(closes, probs);
    // Half the stock's move, say net of a benchmark.
    const half = eventStudy(r, computeChanges(r).changes, { thresholdPp: 5, before: 3, after: 3 }, (from, to) =>
      Math.log(r[to].stockClose / r[from].stockClose) / 2,
    );
    expect(half.rises.mean!.at(-1)).toBeCloseTo((Math.log(1.1) * 100) / 2, 10);
    expect(half.skippedMissing).toBe(0);

    const missing = eventStudy(r, computeChanges(r).changes, { thresholdPp: 5, before: 3, after: 3 }, (from, to) =>
      from === 9 || to === 9 ? null : Math.log(r[to].stockClose / r[from].stockClose),
    );
    expect(missing).toMatchObject({ detected: 1, skippedMissing: 1, rises: { n: 0 } });
    // Every baseline window that includes row 9 is left out too.
    expect(missing.baseline.n).toBe(14 - 7);
  });
});

describe("eventWindowRows", () => {
  it("covers before…after bars around every jump, including skipped ones", () => {
    // Jumps during bars 1 (too early for the study), 7, and 9 (within 3 bars of 7).
    const probs = [0.3, 0.4, 0.4, 0.4, 0.4, 0.4, 0.4, 0.5, 0.5, 0.6, 0.6, 0.6, 0.6, 0.6, 0.6];
    const r = rows(Array(15).fill(100), probs);
    const inside = eventWindowRows(r, computeChanges(r).changes, { thresholdPp: 5, before: 2, after: 1 });
    expect([...inside].sort((a, b) => a - b)).toEqual([0, 1, 2, 5, 6, 7, 8, 9, 10]);
  });
});
