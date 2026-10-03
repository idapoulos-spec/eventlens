import { describe, expect, it } from "vitest";
import { computeChanges } from "./changes";
import { eventStudy, type EventStudy } from "./event-study";
import { eventStudyTests, REFERENCE_OFFSET } from "./event-tests";
import type { ResearchRow } from "./research";
import { simulateRows } from "./test-helpers";

// Simulations run hundreds of analyses; allow for slow CI machines.
const SIMULATION_TIMEOUT = 120_000;

const OPTIONS = { thresholdPp: 1.5, before: 6, after: 6 };
const study = (rows: ResearchRow[]) => eventStudy(rows, computeChanges(rows).changes, OPTIONS);

/** A stock that drifts up by `effect` % in each of the three bars after a rise of at least the threshold. */
const afterRises = (effect: number) => (i: number, rows: ResearchRow[]) => {
  for (let b = 1; b <= 3; b++) {
    const j = i - b;
    if (j >= 1 && rows[j].probability! - rows[j - 1].probability! >= OPTIONS.thresholdPp / 100 - 1e-9) return effect / 100;
  }
  return 0;
};

function firstWithRises(min: number, max: number, make: (seed: number) => ResearchRow[]): EventStudy {
  for (let seed = 1; ; seed++) {
    const s = study(make(seed));
    if (s.rises.n >= min && s.rises.n <= max) return s;
  }
}

describe("eventStudyTests", () => {
  const sample = firstWithRises(6, 8, (seed) => simulateRows({ sessions: 62, seed, sharedVolatility: true }));
  const tests = eventStudyTests(sample);

  it("tests every bar but the reference bar, comparing the mean path with the baseline", () => {
    const ref = sample.offsets.indexOf(REFERENCE_OFFSET);
    expect(tests.rises.bars[ref]).toBeNull();
    const k = sample.offsets.indexOf(3);
    const bar = tests.rises.bars[k]!;
    expect(bar.estimate).toBeCloseTo(sample.rises.mean![k] - sample.baseline.mean![k], 12);
    expect(bar).toMatchObject({ method: "sign_flip", interval: "event_bootstrap", n: sample.rises.n, role: "exploratory" });
    expect(bar.ci![0]).toBeLessThan(bar.estimate!);
    expect(bar.ci![1]).toBeGreaterThan(bar.estimate!);
  });

  it("enumerates every sign pattern with few events, so p-values are exact multiples of 1/2ⁿ", () => {
    const n = sample.rises.n;
    const bar = tests.rises.bars[sample.offsets.indexOf(2)]!;
    expect(bar.resampling).toMatchObject({ unit: "event", units: n, draws: 2 ** n, arrangements: 2 ** (n - 1), minP: 2 / 2 ** n });
    expect((bar.p! * 2 ** n) % 1).toBeCloseTo(0, 9);
    expect(bar.p).toBeGreaterThanOrEqual(2 / 2 ** n);
  });

  it("corrects the bars of rises and falls as one family, and the two path tests as another", () => {
    const bars = [...tests.rises.bars, ...tests.falls.bars].filter((t) => t !== null);
    expect(new Set(bars.map((t) => t!.family))).toEqual(new Set(["event_horizons"]));
    bars.filter((t) => t!.p !== null).forEach((t) => expect(t!.holm!).toBeGreaterThanOrEqual(t!.p!));
    expect([tests.rises.path.family, tests.falls.path.family]).toEqual(["event_paths", "event_paths"]);
    expect(tests.rises.path).toMatchObject({ estimate: null, ci: null, interval: null });
  });

  it("gives no intervals or p-values with fewer than 5 events, but keeps the estimate", () => {
    const few = firstWithRises(2, 4, (seed) => simulateRows({ sessions: 30, seed }));
    const result = eventStudyTests(few).rises;
    const bar = result.bars[few.offsets.indexOf(1)]!;
    expect(bar).toMatchObject({ p: null, ci: null, pUnavailable: "too_few_events", ciUnavailable: "too_few_events" });
    expect(bar.estimate).not.toBeNull();
    expect(result.path.pUnavailable).toBe("too_few_events");
  });

  it("gives the same numbers every time", () => {
    expect(eventStudyTests(sample)).toEqual(tests);
  });
});

describe("simulations: event study", () => {
  // Kalshi jumps come with a more volatile stock (news days, and a volatility spike in the
  // jump hour), but no link in direction. Seeds are fixed.
  function run(effect: number, reps: number) {
    const k = OPTIONS.before + 3; // offset +3
    let tested = 0;
    let barRejects = 0;
    let pathRejects = 0;
    let covered = 0;
    let intervals = 0;
    for (let s = 0; s < reps; s++) {
      const result = study(simulateRows({ sessions: 62, seed: 3000 + s, sharedVolatility: true, drift: effect ? afterRises(effect) : undefined }));
      const tests = eventStudyTests(result).rises;
      const bar = tests.bars[k]!;
      if (bar.p === null) continue;
      tested++;
      if (bar.p < 0.05) barRejects++;
      if (tests.path.p! < 0.05) pathRejects++;
      if (bar.ci) {
        intervals++;
        // The built-in effect at bar +3 is 3 × effect; the baseline barely moves with it.
        if (bar.ci[0] <= 3 * effect && bar.ci[1] >= 3 * effect) covered++;
      }
    }
    return { tested, bar: barRejects / tested, path: pathRejects / tested, coverage: covered / intervals };
  }

  it("rejects at most about 5% of the time with no relationship, per bar and for the whole path", () => {
    const { tested, bar, path, coverage } = run(0, 300);
    expect(tested).toBeGreaterThan(150);
    expect(bar).toBeLessThan(0.06);
    expect(path).toBeLessThan(0.075);
    expect(coverage).toBeGreaterThan(0.92);
  }, SIMULATION_TIMEOUT);

  it("detects a drift after rises more often than chance, and still covers it", () => {
    const { bar, path, coverage } = run(0.4, 300);
    expect(bar).toBeGreaterThan(0.3);
    expect(path).toBeGreaterThan(0.15);
    expect(coverage).toBeGreaterThan(0.9);
  }, SIMULATION_TIMEOUT);
});
