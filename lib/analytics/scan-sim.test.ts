import { describe, expect, it } from "vitest";
import { pearson } from "./correlation";
import { rateSummary, runScan, simulateScan } from "./scan-sim";

const median = (values: number[]) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];

/** Median correlation of the candidates' Kalshi changes within groups and across them. */
function correlations(changes: number[][], groups: number[]) {
  const within: number[] = [];
  const across: number[] = [];
  for (let i = 0; i < changes.length; i++) {
    for (let j = i + 1; j < changes.length; j++) {
      const r = pearson(changes[i], changes[j]);
      if (r !== null) (groups[i] === groups[j] ? within : across).push(r);
    }
  }
  return { within: within.length ? median(within) : null, across: across.length ? median(across) : null };
}

describe("simulateScan", () => {
  it("gives independent candidates no correlation, and clustered ones about 0.9 within a group and 0.3 across", () => {
    const ind = simulateScan({ candidates: 10, structure: "independent", seed: 1 });
    expect(Math.abs(correlations(ind.changes, ind.groups).across!)).toBeLessThan(0.05);
    const clu = simulateScan({ candidates: 20, structure: "clustered", seed: 2 });
    const { within, across } = correlations(clu.changes, clu.groups);
    expect(within!).toBeGreaterThan(0.8);
    expect(across!).toBeGreaterThan(0.2);
    expect(across!).toBeLessThan(0.4);
  });

  it("shares one stock and benchmark across every candidate, on the 90-day grid", () => {
    const { inputs } = simulateScan({ candidates: 3, structure: "clustered", seed: 3 });
    expect(inputs[0].full).toHaveLength(62 * 7);
    expect(inputs[1].full.map((r) => r.stockClose)).toEqual(inputs[0].full.map((r) => r.stockClose));
    expect(inputs[2].closes).toBe(inputs[0].closes);
    expect(inputs[1].full.map((r) => r.kalshiValue)).not.toEqual(inputs[0].full.map((r) => r.kalshiValue));
  });
});

describe("runScan", () => {
  it("decides exactly the same with the simulations' early stop as with every draw", () => {
    let survivors = 0;
    let stoppedEarly = 0;
    for (let k = 0; k < 12; k++) {
      // Short scans, some with a candidate whose effect puts its p near the thresholds.
      const { inputs } = simulateScan({ candidates: 20, structure: k % 2 ? "clustered" : "independent", seed: 90_000 + k, sessions: 21, planted: k % 3 ? { index: 3, effect: 0.6 * (k % 3) } : undefined });
      const early = runScan(inputs);
      const full = runScan(inputs, { early: false });
      expect(early.survivesHolm).toEqual(full.survivesHolm);
      expect(early.survivesBh).toEqual(full.survivesBh);
      expect(early.firstPs).toEqual(full.firstPs);
      survivors += full.survivesBh.filter(Boolean).length;
      stoppedEarly += early.ps.filter((p, i) => p !== full.ps[i]).length;
    }
    // The check means something only if both happened.
    expect(survivors).toBeGreaterThan(0);
    expect(stoppedEarly).toBeGreaterThan(0);
  });
});

describe("rateSummary", () => {
  it("gives the rate, its standard error, and the Wilson interval", () => {
    const s = rateSummary(20, 400);
    expect(s.rate).toBe(0.05);
    expect(s.se).toBeCloseTo(Math.sqrt(0.05 * 0.95 / 400), 12);
    // Wilson 95% for 20/400: 0.0326–0.0759.
    expect(s.lo).toBeCloseTo(0.0326, 3);
    expect(s.hi).toBeCloseTo(0.0759, 3);
  });
});
