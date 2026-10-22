import { describe, expect, it } from "vitest";
import { nullRates } from "./scan-sim";

// The scan's validation, fixed before it ran (feat/scan-markets plan, 2026-10-22): with no candidate
// related to the stock, how often does a scan show at least one result surviving Holm or
// Benjamini–Hochberg? Each setting runs once on fresh seeds (5,000,000–5,599,999 are used only by
// the scan's simulations); figures in the README. The scan is computed as the page computes it
// (scan-sim.ts runScan: 999 draws, 19,999 for first p under 0.10, both corrections at 5%), on 62
// hourly sessions (the default 90-day window and market-model sample).
//
// Fails if the share of scans with any survivor is 7.5% or more (no lower bar: with correlated
// candidates both corrections are conservative by design), or if candidates' own p is under 0.05 in
// 7.5% or more of them.
// Clustered candidates: groups of five, about 0.9 correlated within and 0.3 across, the shared part
// moving the benchmark and the stock's volatility (see scan-sim.ts).

// A scan of 100 runs its 300 data sets in about 9 minutes here; allow for slow CI machines.
const SIMULATION_TIMEOUT = 2_400_000;

describe("simulations: scans with no related candidate (clustered)", () => {
  it("10 candidates: 400 scans, seeds 5,300,000–5,300,399", () => {
    const r = nullRates({ candidates: 10, structure: "clustered" }, 5_300_000, 400);
    expect(r.candidates).toBe(10 * 400);
    expect(r.holm / r.scans).toBeLessThan(0.075);
    expect(r.bh / r.scans).toBeLessThan(0.075);
    expect(r.candidateRejections / r.candidates).toBeLessThan(0.075);
  }, SIMULATION_TIMEOUT);

  it("30 candidates: 400 scans, seeds 5,400,000–5,400,399", () => {
    const r = nullRates({ candidates: 30, structure: "clustered" }, 5_400_000, 400);
    expect(r.candidates).toBe(30 * 400);
    expect(r.holm / r.scans).toBeLessThan(0.075);
    expect(r.bh / r.scans).toBeLessThan(0.075);
    expect(r.candidateRejections / r.candidates).toBeLessThan(0.075);
  }, SIMULATION_TIMEOUT);
});
