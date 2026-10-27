import { describe, expect, it } from "vitest";
import type { DetectableCorrelation } from "./correlation-test";
import { calibrationFor, EVIDENCE, evidenceRating, scanLeadRating, type Calibration, type EvidenceInput } from "./evidence";
import type { Fragility, LeaveOneOut } from "./fragility";
import type { TestResult } from "./inference";

// Each of the README's rules R1–R11, in order, on hand-made results: these test the rules as
// written, not how often they fire (evidence-rates.sim.test.ts does that).

const test = (p: number | null, estimate = 0.2, ci: [number, number] | null = [0.05, 0.35]): TestResult => ({
  estimate,
  ci: p === null ? null : ci,
  p,
  holm: null,
  bh: null,
  role: "primary",
  family: null,
  method: "wild_bootstrap",
  interval: "wild_bootstrap",
  resampling: { unit: "session", units: 62, runDays: null, draws: 999, arrangements: null, minP: 0.001, refit: "market_model" },
  n: 400,
  nEffective: null,
  pUnavailable: p === null ? "too_few_blocks" : null,
  ciUnavailable: p === null ? "too_few_blocks" : ci === null ? "unstable" : null,
});
const fragility = (effective: number) => ({ movement: { intervals: 400, moves: 60, top1: 0.1, top5: 0.3, effective } }) as Fragility;
const loo = (flips: number) => ({ flips }) as LeaveOneOut;
const detectable = (r: number | null): DetectableCorrelation => ({ r, max: 0.8, slope: null, power: 0.8, samples: 999, unit: "session", units: 62 });
const none: Calibration = { optimisticPower: false, liberalIntervals: false };

const rate = (over: Partial<EvidenceInput>) =>
  evidenceRating({ primary: test(0.2), fragility: fragility(25), leaveOneOut: loo(0), detectable: detectable(0.25), calibration: none, ...over });

describe("the evidence rating's rules, in order", () => {
  it("R1: no primary test, no rating", () => {
    expect(rate({ primary: null })).toMatchObject({ level: "none", rule: "no_primary" });
  });

  it("R2: no p-value is not enough data, whatever else is known", () => {
    expect(rate({ primary: test(null), fragility: null, detectable: undefined, leaveOneOut: undefined })).toMatchObject({ level: "not_enough_data", rule: "no_p" });
  });

  it("R3: waits for the leave-one-out check when significant, and for the detectable size when not", () => {
    expect(rate({ primary: test(0.01), leaveOneOut: undefined })).toMatchObject({ level: "pending", rule: "pending" });
    // F1 alone would make it Weak, but the rating still waits (R3 comes first).
    expect(rate({ primary: test(0.01), fragility: fragility(3), leaveOneOut: undefined }).level).toBe("pending");
    expect(rate({ primary: test(0.3), detectable: undefined })).toMatchObject({ level: "pending", rule: "pending" });
    // A significant result doesn't need the detectable size (the page computes none for it).
    expect(rate({ primary: test(0.01), detectable: undefined }).level).not.toBe("pending");
    // And a result that isn't significant doesn't need the leave-one-out check.
    expect(rate({ primary: test(0.3), leaveOneOut: undefined }).level).not.toBe("pending");
  });

  it("R4: not significant with fewer than 10 effective moves (or no diagnostics) is not enough data", () => {
    expect(rate({ primary: test(0.3), fragility: fragility(9.99) })).toMatchObject({ level: "not_enough_data", rule: "few_moves" });
    expect(rate({ primary: test(0.3), fragility: null })).toMatchObject({ level: "not_enough_data", rule: "few_moves" });
    expect(rate({ primary: test(0.3), fragility: fragility(10) }).rule).not.toBe("few_moves");
  });

  it("R5: not significant without the power to find ±0.30 is not enough data, judged on the two decimals shown", () => {
    for (const d of [null, detectable(null), detectable(0.31), detectable(0.306)]) {
      expect(rate({ primary: test(0.3), detectable: d })).toMatchObject({ level: "not_enough_data", rule: "low_power" });
    }
    // 0.304 shows as ±0.30: within the threshold.
    expect(rate({ primary: test(0.3), detectable: detectable(0.304) })).toMatchObject({ level: "no_clear_link", rule: "no_link" });
    expect(rate({ primary: test(0.3), detectable: detectable(EVIDENCE.maxDetectable) }).level).toBe("no_clear_link");
  });

  it("R6: not significant in a window whose detectable size failed validation is not enough data", () => {
    expect(rate({ primary: test(0.3), detectable: detectable(0.2), calibration: { ...none, optimisticPower: true } })).toMatchObject({ level: "not_enough_data", rule: "power_miss" });
  });

  it("R7: otherwise, not significant is no clear link (p = 0.05 is not significant)", () => {
    expect(rate({ primary: test(0.05), detectable: detectable(0.2) })).toMatchObject({ level: "no_clear_link", rule: "no_link" });
    // Daily intervals running narrow don't matter for a result that isn't significant.
    expect(rate({ primary: test(0.6), calibration: { ...none, liberalIntervals: true } }).level).toBe("no_clear_link");
  });

  it("R8: significant but fragile (F1, F3, or a check that couldn't run) is weak, however small p is", () => {
    expect(rate({ primary: test(0.001), fragility: fragility(9) })).toMatchObject({ level: "weak", rule: "fragile", fragile: { movement: true, leaveOneOut: false } });
    expect(rate({ primary: test(0.001), leaveOneOut: loo(1) })).toMatchObject({ level: "weak", rule: "fragile", fragile: { movement: false, leaveOneOut: true } });
    expect(rate({ primary: test(0.001), leaveOneOut: null })).toMatchObject({ level: "weak", rule: "fragile", fragile: { leaveOneOut: true } });
    expect(rate({ primary: test(0.001), fragility: null })).toMatchObject({ level: "weak", rule: "fragile", fragile: { movement: true } });
  });

  it("R9: significant without an interval is weak", () => {
    expect(rate({ primary: test(0.001, 0.2, null) })).toMatchObject({ level: "weak", rule: "no_interval" });
  });

  it("R10: p under 0.005, stable, with intervals that weren't found too narrow, is strong", () => {
    expect(rate({ primary: test(0.004) })).toMatchObject({ level: "strong", rule: "strong" });
    expect(rate({ primary: test(0.001) }).level).toBe("strong");
    // An optimistic detectable size doesn't touch a significant result.
    expect(rate({ primary: test(0.001), calibration: { ...none, optimisticPower: true } }).level).toBe("strong");
  });

  it("R11: otherwise significant is moderate: p from 0.005, or daily intervals that ran narrow", () => {
    expect(rate({ primary: test(0.005) })).toMatchObject({ level: "moderate", rule: "moderate" });
    expect(rate({ primary: test(0.049) }).level).toBe("moderate");
    expect(rate({ primary: test(0.001), calibration: { ...none, liberalIntervals: true } })).toMatchObject({ level: "moderate", rule: "moderate" });
  });

  it("notes a small link only for Moderate or Strong with |r| below 0.10 as shown", () => {
    expect(rate({ primary: test(0.001, 0.09) })).toMatchObject({ level: "strong", smallLink: true });
    expect(rate({ primary: test(0.02, -0.094) })).toMatchObject({ level: "moderate", smallLink: true });
    // −0.0951 shows as −0.10, so no note.
    expect(rate({ primary: test(0.02, -0.0951) }).smallLink).toBe(false);
    expect(rate({ primary: test(0.001, 0.1) }).smallLink).toBe(false);
    expect(rate({ primary: test(0.001, 0.05), leaveOneOut: loo(2) })).toMatchObject({ level: "weak", smallLink: false });
    expect(rate({ primary: test(0.3, 0.05) })).toMatchObject({ level: "no_clear_link", smallLink: false });
  });
});

describe("the window's calibration misses", () => {
  it("are the detectable size at 30 days (either resolution) and 180 daily days, and daily intervals past 90 days", () => {
    expect(calibrationFor("hourly", 30, false)).toEqual({ optimisticPower: true, liberalIntervals: false });
    expect(calibrationFor("daily", 30, false)).toEqual({ optimisticPower: true, liberalIntervals: false });
    expect(calibrationFor("daily", 180, true)).toEqual({ optimisticPower: true, liberalIntervals: true });
    expect(calibrationFor("daily", 365, true)).toEqual({ optimisticPower: false, liberalIntervals: true });
    expect(calibrationFor("daily", "all", true)).toEqual({ optimisticPower: false, liberalIntervals: true });
    // A young market's 180D is its 90 days: no long-window miss.
    expect(calibrationFor("daily", 180, false)).toEqual(none);
    for (const w of [7, 90, 180, 365, "all"] as const) expect(calibrationFor("hourly", w, w !== 7 && w !== 90)).toEqual(none);
    expect(calibrationFor("daily", 90, false)).toEqual(none);
  });
});

describe("a scan's strongest lead", () => {
  const lead = (over: Partial<Parameters<typeof scanLeadRating>[0]>) =>
    scanLeadRating({ primary: test(0.001), fragility: fragility(25), leaveOneOut: loo(0), bh: 0.01, calibration: none, ...over });

  it("is rated on its BH-adjusted p: nothing stood out when it doesn't survive, or not enough data with F1", () => {
    expect(lead({ bh: 0.05 })).toMatchObject({ level: "nothing_stood_out", rule: "not_surviving", smallLink: false });
    expect(lead({ bh: 0.2, fragility: fragility(4) })).toMatchObject({ level: "not_enough_data", rule: "few_moves" });
    // A lead that doesn't survive needs no leave-one-out check.
    expect(lead({ bh: 0.2, leaveOneOut: undefined }).level).toBe("nothing_stood_out");
  });

  it("waits for the leave-one-out check, then follows the page's significant rules", () => {
    expect(lead({ leaveOneOut: undefined })).toMatchObject({ level: "pending" });
    expect(lead({ leaveOneOut: loo(1) })).toMatchObject({ level: "weak", rule: "fragile" });
    expect(lead({ fragility: fragility(8) })).toMatchObject({ level: "weak", rule: "fragile" });
    expect(lead({ primary: test(0.001, 0.2, null) })).toMatchObject({ level: "weak", rule: "no_interval" });
    expect(lead({ bh: 0.004 })).toMatchObject({ level: "strong" });
    // Strong uses the scan's adjusted p, not the page's.
    expect(lead({ primary: test(0.001), bh: 0.006 })).toMatchObject({ level: "moderate" });
    expect(lead({ bh: 0.001, calibration: { ...none, liberalIntervals: true } })).toMatchObject({ level: "moderate" });
    expect(lead({ bh: 0.001, primary: test(0.001, -0.08) })).toMatchObject({ level: "strong", smallLink: true });
  });
});
