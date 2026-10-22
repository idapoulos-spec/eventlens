import { describe, expect, it } from "vitest";
import { nullRates } from "./scan-sim";

// The scan's validation, fixed before it ran (feat/scan-markets plan, 2026-10-22): with no candidate
// related to the stock, how often does a scan show at least one result surviving Holm or
// Benjamini–Hochberg? Each setting runs once on fresh seeds (5,000,000–5,599,999 are used only by
// the scan's simulations); figures in the README. The scan is computed as the page computes it
// (scan-sim.ts runScan: 999 draws, 19,999 for first p under 0.10, both corrections at 5%), on 62
// hourly sessions (the default 90-day window and market-model sample).
//
// Fails if the share of scans with any survivor is 7.5% or more, or (independent candidates) under
// 2%, or if candidates' own p is under 0.05 in 7.5% or more of them.
// Independent candidates; news days shared (see scan-sim.ts).

// A scan of 100 runs its 300 data sets in about 9 minutes here; allow for slow CI machines.
const SIMULATION_TIMEOUT = 2_400_000;

describe("simulations: scans with no related candidate (independent)", () => {
  it("10 candidates: 400 scans, seeds 5,000,000–5,000,399", () => {
    const r = nullRates({ candidates: 10, structure: "independent" }, 5_000_000, 400);
    expect(r.candidates).toBe(10 * 400);
    expect(r.holm / r.scans).toBeLessThan(0.075);
    expect(r.bh / r.scans).toBeLessThan(0.075);
    // Independent candidates: both corrections should sit near 5%, so under 2% would mean the scan's finer p is conservative in the tail.
    expect(r.holm / r.scans).toBeGreaterThanOrEqual(0.02);
    expect(r.bh / r.scans).toBeGreaterThanOrEqual(0.02);
    expect(r.candidateRejections / r.candidates).toBeLessThan(0.075);
  }, SIMULATION_TIMEOUT);

  it("30 candidates: 400 scans, seeds 5,100,000–5,100,399", () => {
    const r = nullRates({ candidates: 30, structure: "independent" }, 5_100_000, 400);
    expect(r.candidates).toBe(30 * 400);
    expect(r.holm / r.scans).toBeLessThan(0.075);
    expect(r.bh / r.scans).toBeLessThan(0.075);
    // Independent candidates: both corrections should sit near 5%, so under 2% would mean the scan's finer p is conservative in the tail.
    expect(r.holm / r.scans).toBeGreaterThanOrEqual(0.02);
    expect(r.bh / r.scans).toBeGreaterThanOrEqual(0.02);
    expect(r.candidateRejections / r.candidates).toBeLessThan(0.075);
  }, SIMULATION_TIMEOUT);
});
