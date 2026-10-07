import { describe, expect, it } from "vitest";
import { computeChanges } from "./changes";
import { detectableCorrelation, WILD_DRAWS } from "./correlation-test";
import { adjustedChanges, benchmarkReturnsByT, fitMarketModel, primaryTest } from "./market-model";
import { DETECTABLE_POWER, MAX_DETECTABLE, POWER_SAMPLES, powerAt, scoreVarianceRatios, simulatePower } from "./power";
import { seededRng } from "./random";
import { lastSessions, simulateMarketRows, type MarketSimOptions } from "./test-helpers";
import { frame } from "./wild-bootstrap";

// Simulations run hundreds of analyses; allow for slow CI machines.
const SIMULATION_TIMEOUT = 300_000;

/** The primary test's inputs for one simulated data set, as the page computes them. */
function sample(options: MarketSimOptions, window: number) {
  const { rows: full, closesByT } = simulateMarketRows(options);
  const model = fitMarketModel(full, closesByT)!;
  const abnormal = adjustedChanges(computeChanges(lastSessions(full, window, options.resolution)).changes, benchmarkReturnsByT(full, closesByT), model);
  return { model, abnormal };
}

const design = { sessions: 62, resolution: "hourly", sharedVolatility: true, kalshiInMarket: 0.1 } as const;

describe("detectableCorrelation", () => {
  const { model, abnormal } = sample({ ...design, seed: 50 }, 21);

  it("reports the smallest correlation detected 80% of the time, with the window's sessions", () => {
    const found = detectableCorrelation(abnormal, "hourly", { refit: model.sample })!;
    expect(found).toMatchObject({ power: DETECTABLE_POWER, samples: POWER_SAMPLES, max: MAX_DETECTABLE, unit: "session", units: 21 });
    expect(found.r).toBeGreaterThan(0.1);
    expect(found.r).toBeLessThan(MAX_DETECTABLE);
    expect(Math.abs(found.slope!)).toBeGreaterThan(0);
  });

  it("is smaller with more sessions", () => {
    const found = detectableCorrelation(abnormal, "hourly", { refit: model.sample })!;
    const long = sample({ ...design, seed: 50 }, 62);
    expect(detectableCorrelation(long.abnormal, "hourly", { refit: long.model.sample })!.r).toBeLessThan(found.r!);
  });

  it("averages over volatility ratios centered near 1", () => {
    const median = (window: number) => {
      const s = sample({ ...design, seed: 50 }, window);
      const block = Int32Array.from(s.abnormal, (_, i) => Math.floor(i / 6));
      const f = frame(
        { r: s.abnormal.map((c) => c.logReturn), m: null, block },
        { index: Int32Array.from(s.abnormal, (_, i) => i), x: s.abnormal.map((c) => c.probChangePp), steps: s.abnormal.map((c) => c.step), market: false },
      )!;
      return Array.from(scoreVarianceRatios(f, 400, seededRng("test"))).sort((a, b) => a - b)[200];
    };
    for (const m of [median(21), median(62)]) {
      expect(m).toBeGreaterThan(0.75);
      expect(m).toBeLessThan(1.25);
    }
  });

  it("is null when the test can't run", () => {
    const week = sample({ ...design, seed: 50 }, 5);
    expect(detectableCorrelation(week.abnormal, "hourly", { refit: week.model.sample })).toBeNull();
  });
});

describe("simulatePower", () => {
  it("rejects about 5% of the time with no effect built in", () => {
    // A frame for the plain correlation of one simulated window, its own pairs as stage 1.
    const { abnormal } = sample({ ...design, seed: 51 }, 62);
    const x = abnormal.map((c) => c.probChangePp);
    const block = Int32Array.from(abnormal, (_, i) => Math.floor(i / 6));
    const f = frame(
      { r: abnormal.map((c) => c.logReturn), m: null, block },
      { index: Int32Array.from(abnormal, (_, i) => i), x, steps: abnormal.map((c) => c.step), market: false },
    )!;
    const rate = powerAt(simulatePower(f, 62, POWER_SAMPLES, seededRng("test")), 0);
    expect(rate).toBeGreaterThan(0.025);
    expect(rate).toBeLessThan(0.08);
  });
});

describe("simulations: the detectable correlation is detected about 80% of the time", () => {
  // For each of 20 designs (Kalshi's path, the benchmark, and the stock's volatility pattern),
  // the detectable correlation is computed from one sample, as the page does. Then 20 fresh
  // samples of the same design, with new noise and that effect built in, each get the full
  // primary test with its own 999-draw bootstrap. Kalshi tracks the benchmark and shares the
  // stock's volatility. Seeds are fixed, so these results are the same on every run.
  //
  // Validation seeds, never used while developing the method: designs 80,000–80,019,
  // 81,000–81,019, 82,000–82,019, and 83,000–83,019, each design's fresh samples seeded
  // 1,000,000 + 100 × design + j. The method (averaging over the volatility's uncertainty,
  // the 0.8 cap) was chosen on designs 52,000–55,019 and their samples; those results aren't
  // the validation. This was run once, with the 72–88% band and what to do outside it decided
  // beforehand. Improving the method needs another fresh set of seeds, not these.
  const hourly = design;
  const daily = { sessions: 62, resolution: "daily", sharedVolatility: true, kalshiInMarket: 0.3 } as const;

  function detectionRate(options: Omit<MarketSimOptions, "seed">, window: number, firstSeed: number) {
    let detected = 0;
    let tested = 0;
    let aboveMax = 0;
    const rs: number[] = [];
    for (let k = 0; k < 20; k++) {
      const seed = firstSeed + k;
      const { model, abnormal } = sample({ ...options, seed }, window);
      const found = detectableCorrelation(abnormal, options.resolution, { refit: model.sample })!;
      if (found.r === null) {
        aboveMax++;
        continue;
      }
      rs.push(found.r);
      for (let j = 0; j < 20; j++) {
        const fresh = sample({ ...options, seed, noiseSeed: 1_000_000 + 100 * seed + j, effect: found.slope! * 100 }, window);
        const test = primaryTest(fresh.abnormal, fresh.model, options.resolution, { draws: WILD_DRAWS });
        if (test.p === null) continue;
        tested++;
        if (test.p < 0.05) detected++;
      }
    }
    rs.sort((a, b) => a - b);
    return { rate: detected / tested, tested, aboveMax, medianR: rs[Math.floor(rs.length / 2)] };
  }

  it("hourly, with 21 sessions (about 30 days)", () => {
    const { rate } = detectionRate(hourly, 21, 80_000);
    expect(rate).toBeGreaterThan(0.72);
    expect(rate).toBeLessThan(0.88);
  }, SIMULATION_TIMEOUT);

  it("hourly, with 62 sessions (about 90 days)", () => {
    const { rate, tested } = detectionRate(hourly, 62, 81_000);
    expect(tested).toBe(400);
    expect(rate).toBeGreaterThan(0.72);
    expect(rate).toBeLessThan(0.88);
  }, SIMULATION_TIMEOUT);

  it("daily, with 62 trading days", () => {
    const { rate } = detectionRate(daily, 62, 82_000);
    expect(rate).toBeGreaterThan(0.72);
    expect(rate).toBeLessThan(0.88);
  }, SIMULATION_TIMEOUT);

  it("gives no number for most 20-day daily samples, and the few numbers it gives are unreliable", () => {
    const { aboveMax, rate } = detectionRate(daily, 20, 83_000);
    expect(aboveMax).toBeGreaterThanOrEqual(15);
    // Outside the 72–88% band: 27 of 60, as the page and README say (UNRELIABLE_DAILY in ResearchPanel.tsx).
    expect(rate).toBeLessThan(0.72);
  }, SIMULATION_TIMEOUT);
});
