import { describe, expect, it } from "vitest";
import type { ChangePoint } from "./changes";
import { pearson } from "./correlation";
import { rollingCorrelation } from "./rolling";

const change = (step: number, probChangePp: number, logReturn: number): ChangePoint => ({ t: step * 1000, step, probChangePp, logReturn });

describe("rollingCorrelation", () => {
  const changes = [change(1, 1, 0.01), change(2, -1, 0.02), change(3, 2, 0.01), change(4, 0, -0.01), change(5, 3, 0.03)];

  it("correlates each run of consecutive changes, stamped at its last one", () => {
    const points = rollingCorrelation(changes, 3);
    expect(points.map((p) => [p.startT, p.t, p.n])).toEqual([
      [1000, 3000, 3],
      [2000, 4000, 3],
      [3000, 5000, 3],
    ]);
    expect(points[1].r).toBeCloseTo(pearson([-1, 2, 0], [0.02, 0.01, -0.01])!, 12);
  });

  it("has no correlation for a window where Kalshi didn't move", () => {
    const flat = [change(1, 0, 0.01), change(2, 0, 0.02), change(3, 0, -0.01), change(4, 1, 0.01)];
    expect(rollingCorrelation(flat, 3).map((p) => p.r === null)).toEqual([true, false]);
  });

  it("returns nothing when there are fewer changes than the window", () => {
    expect(rollingCorrelation(changes, 6)).toEqual([]);
    expect(rollingCorrelation(changes, 1)).toEqual([]);
  });
});
