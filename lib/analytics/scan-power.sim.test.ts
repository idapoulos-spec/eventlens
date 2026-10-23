import { describe, expect, it } from "vitest";
import { ALPHA } from "./inference";
import { rankScan } from "./scan";
import { runScan, simulateScan } from "./scan-sim";

// The price of scanning (feat/scan-markets plan, 2026-10-22). Descriptive, with no pass bar: one
// candidate of 30 independent ones moves the stock (0.3% per pp in the same hour, the effect
// fragility-rates.sim.test.ts uses), 62 hourly sessions, 200 scans on fresh seeds
// 5,600,000–5,600,199, run once; figures in the README. How often does the scan find it, against
// how often its own page alone would (p under 0.05), and how often does an unrelated candidate
// survive alongside it?

const SIMULATION_TIMEOUT = 2_400_000;

describe("simulations: a scan with one related candidate among 30", () => {
  it("200 scans, seeds 5,600,000–5,600,199", () => {
    const count = { scans: 0, alone: 0, holm: 0, bh: 0, first: 0, falseHolm: 0, falseBh: 0 };
    for (let seed = 5_600_000; seed < 5_600_200; seed++) {
      const out = runScan(simulateScan({ candidates: 30, structure: "independent", seed, planted: { index: 0, effect: 0.3 } }).inputs);
      const order = rankScan(out.ps.map((p, i) => ({ p, firstP: out.firstPs[i], key: String(i).padStart(3, "0") })));
      count.scans++;
      if (out.firstPs[0] !== null && out.firstPs[0] < ALPHA) count.alone++;
      if (out.survivesHolm[0]) count.holm++;
      if (out.survivesBh[0]) count.bh++;
      if (order[0] === 0) count.first++;
      if (out.survivesHolm.slice(1).some(Boolean)) count.falseHolm++;
      if (out.survivesBh.slice(1).some(Boolean)) count.falseBh++;
    }
    expect(count.scans).toBe(200);
    // Sanity only: Benjamini–Hochberg finds whatever Holm finds.
    expect(count.holm).toBeLessThanOrEqual(count.bh);
  }, SIMULATION_TIMEOUT);
});
