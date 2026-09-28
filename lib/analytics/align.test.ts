import { describe, expect, it } from "vitest";
import { alignSeries, mergeSeries } from "./align";
import type { TimePoint } from "./types";

const pts = (...pairs: [number, number][]): TimePoint[] => pairs.map(([t, value]) => ({ t, value }));

describe("mergeSeries", () => {
  it("returns an empty series for no input or empty input", () => {
    expect(mergeSeries()).toEqual([]);
    expect(mergeSeries([], [])).toEqual([]);
  });

  it("merges series into one chronologically sorted series", () => {
    expect(mergeSeries(pts([3, 0.3], [1, 0.1]), pts([2, 0.2]))).toEqual(pts([1, 0.1], [2, 0.2], [3, 0.3]));
  });

  it("lets the later series win on a shared timestamp", () => {
    expect(mergeSeries(pts([1, 0.1], [2, 0.2]), pts([2, 0.25]))).toEqual(pts([1, 0.1], [2, 0.25]));
  });

  it("keeps the later point on a duplicate timestamp within one series", () => {
    expect(mergeSeries(pts([1, 0.1], [1, 0.15]))).toEqual(pts([1, 0.15]));
  });

  it("does not mutate its inputs", () => {
    const a = pts([2, 0.2], [1, 0.1]);
    const b = pts([2, 0.25]);
    mergeSeries(a, b);
    expect(a).toEqual(pts([2, 0.2], [1, 0.1]));
    expect(b).toEqual(pts([2, 0.25]));
  });
});

describe("alignSeries", () => {
  it("returns an empty series when either input is empty", () => {
    expect(alignSeries([], [])).toEqual([]);
    expect(alignSeries(pts([1, 0.5]), [])).toEqual([]);
    expect(alignSeries([], pts([1, 100]))).toEqual([]);
  });

  it("carries each series' last known value forward on the shared timeline", () => {
    const aligned = alignSeries(pts([1, 0.5], [3, 0.6], [5, 0.55]), pts([2, 100], [4, 110]));
    expect(aligned.map((p) => p.t)).toEqual([2, 3, 4, 5]);
    expect(aligned.map((p) => p.stockPrice)).toEqual([100, 100, 110, 110]);
    expect(aligned.map((p) => p.probability)).toEqual([50, 60, 60, expect.closeTo(55, 10)]);
  });

  it("drops points before both series have started", () => {
    const aligned = alignSeries(pts([1, 0.5], [2, 0.52]), pts([3, 100]));
    expect(aligned).toHaveLength(1);
    expect(aligned[0]).toMatchObject({ t: 3, probability: 52, stockPrice: 100 });
  });

  it("measures changes from the first aligned observation", () => {
    const aligned = alignSeries(pts([1, 0.4], [2, 0.5]), pts([1, 200], [2, 210]));
    expect(aligned[0]).toEqual({ t: 1, probability: 40, probabilityChange: 0, stockPrice: 200, stockReturn: 0 });
    expect(aligned[1].probability).toBe(50);
    expect(aligned[1].probabilityChange).toBeCloseTo(10, 10);
    expect(aligned[1].stockReturn).toBeCloseTo(5, 10);
  });

  it("lists a timestamp shared by both series once", () => {
    const aligned = alignSeries(pts([1, 0.5], [2, 0.6]), pts([1, 100], [2, 101]));
    expect(aligned.map((p) => p.t)).toEqual([1, 2]);
  });

  it("sorts unsorted input without mutating it", () => {
    const probability = pts([2, 0.6], [1, 0.5]);
    const stock = pts([2, 101], [1, 100]);
    const aligned = alignSeries(probability, stock);
    expect(aligned.map((p) => [p.t, p.probability, p.stockPrice])).toEqual([
      [1, 50, 100],
      [2, 60, 101],
    ]);
    expect(probability).toEqual(pts([2, 0.6], [1, 0.5]));
    expect(stock).toEqual(pts([2, 101], [1, 100]));
  });

  it("handles probabilities of 0% and 100%", () => {
    const aligned = alignSeries(pts([1, 0], [2, 1]), pts([1, 100]));
    expect(aligned.map((p) => [p.probability, p.probabilityChange])).toEqual([
      [0, 0],
      [100, 100],
    ]);
    const falling = alignSeries(pts([1, 1], [2, 0]), pts([1, 100]));
    expect(falling.map((p) => [p.probability, p.probabilityChange])).toEqual([
      [100, 0],
      [0, -100],
    ]);
  });

  it("has no stock return when the base price is not positive", () => {
    const aligned = alignSeries(pts([1, 0.5], [2, 0.5]), pts([1, 0], [2, 10]));
    expect(aligned.map((p) => p.stockReturn)).toEqual([null, null]);
  });
});
