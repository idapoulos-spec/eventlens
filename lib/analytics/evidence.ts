import type { DetectableCorrelation } from "./correlation-test";
import { FRAGILE, type Fragility, type LeaveOneOut } from "./fragility";
import { ALPHA, type TestResult } from "./inference";
import type { Resolution } from "./research";

/**
 * How strong the evidence is, for the plain-English summary: one rating from results the page
 * already computes (the primary test, the fragility diagnostics and leave-one-out check, and the
 * detectable size). The rules were fixed on 2026-10-27 and written into the README ("In plain
 * English") before any simulation of them ran; they're not tuned to any result. The first rule
 * that matches decides. evidence-rates.sim.test.ts checks how often each rating comes up.
 */

export type EvidenceLevel = "not_enough_data" | "no_clear_link" | "weak" | "moderate" | "strong";

export const EVIDENCE = {
  /** R10: below this p (and not fragile), the evidence is Strong (Benjamin et al. 2018). */
  strongP: 0.005,
  /** R5: a result that isn't significant is "No clear link" only if the detectable correlation is at most this (Cohen's medium). */
  maxDetectable: 0.3,
  /** Below this |r|, a Moderate or Strong result gets a note that the link itself is small. */
  smallR: 0.1,
} as const;

/** Why a rating is what it is: the README's rules R1–R11. */
export type EvidenceRule =
  /** R1: no market-adjusted returns, so no primary test. */
  | "no_primary"
  /** R2: the primary test has no p-value. */
  | "no_p"
  /** R3: the leave-one-out check (p < 0.05) or the detectable size (p ≥ 0.05) is still computing. */
  | "pending"
  /** R4: not significant, and Kalshi's movement rests on fewer than 10 effective intervals (F1). */
  | "few_moves"
  /** R5: not significant, and the detectable correlation is missing, above the cap, or above maxDetectable. */
  | "low_power"
  /** R6: not significant, in a window whose detectable size failed validation. */
  | "power_miss"
  /** R7. */
  | "no_link"
  /** R8: significant but fragile (F1 or F3). */
  | "fragile"
  /** R9: significant without a confidence interval. */
  | "no_interval"
  /** R10. */
  | "strong"
  /** R11. */
  | "moderate";

/** Validations whose whole 95% range fell on the wrong side of their target (README), for the window shown. */
export interface Calibration {
  /** The detectable size claims 80% but was validated below it: 30D hourly (75.0%), 30D daily (45.0%), 180D daily (74.2%). */
  optimisticPower: boolean;
  /** The primary test's intervals ran narrow (90.0% coverage, 7.0% false positives): daily windows past 90 days. */
  liberalIntervals: boolean;
}

/**
 * The window's calibration misses, by its choice as the page makes it. `long` is a window past the 90
 * days the page loads with (not one cut to the same rows by a young market); the page's daily flags
 * use the same split.
 */
export function calibrationFor(resolution: Resolution, window: number | "all", long: boolean): Calibration {
  const daily = resolution === "daily";
  return {
    optimisticPower: window === 30 || (daily && long && window === 180),
    liberalIntervals: daily && long,
  };
}

/** What the fragile warning's checks say, where the rating needs them: F1, and F3 once the leave-one-out check has run. */
export interface FragileChecks {
  /** F1: fewer than FRAGILE.minEffectiveMoves effective intervals of Kalshi movement (or no diagnostics). */
  movement: boolean;
  /** F3: a leave-one-out rerun changes the decision at 5% (or the check couldn't run). */
  leaveOneOut: boolean;
}

export interface EvidenceRating {
  /** A rating, "pending" while a result it needs is computing, or "none" without a primary test. */
  level: EvidenceLevel | "pending" | "none";
  rule: EvidenceRule;
  /** Which of F1 and F3 tripped, for a significant result (both false otherwise). */
  fragile: FragileChecks;
  /** Moderate or Strong, but |r| (as shown, two decimals) below EVIDENCE.smallR. */
  smallLink: boolean;
}

export interface EvidenceInput {
  primary: TestResult | null;
  fragility: Fragility | null;
  /** Undefined while it's computing; null when it couldn't run. */
  leaveOneOut: LeaveOneOut | null | undefined;
  /** Undefined while it's computing; null when it couldn't run. */
  detectable: DetectableCorrelation | null | undefined;
  calibration: Calibration;
}

/** |v| as the page shows it, to two decimals, so a rule never contradicts the number beside it. */
const shown = (v: number) => Number(Math.abs(v).toFixed(2));

/** F1 from the diagnostics: a result with a p-value but no diagnostics counts as tripped. */
const fewMoves = (f: Fragility | null) => f === null || f.movement.effective < FRAGILE.minEffectiveMoves;

const smallLink = (level: EvidenceLevel, primary: TestResult) =>
  (level === "moderate" || level === "strong") && primary.estimate !== null && shown(primary.estimate) < EVIDENCE.smallR;

const NOT_FRAGILE: FragileChecks = { movement: false, leaveOneOut: false };

export function evidenceRating({ primary, fragility, leaveOneOut, detectable, calibration }: EvidenceInput): EvidenceRating {
  const rated = (level: EvidenceRating["level"], rule: EvidenceRule, fragile = NOT_FRAGILE): EvidenceRating => ({
    level,
    rule,
    fragile,
    smallLink: primary !== null && level !== "pending" && level !== "none" && smallLink(level, primary),
  });
  if (primary === null) return rated("none", "no_primary");
  if (primary.p === null) return rated("not_enough_data", "no_p");
  const significant = primary.p < ALPHA;
  if ((significant ? leaveOneOut : detectable) === undefined) return rated("pending", "pending");

  if (!significant) {
    if (fewMoves(fragility)) return rated("not_enough_data", "few_moves");
    if (!detectable || detectable.r === null || shown(detectable.r) > EVIDENCE.maxDetectable) return rated("not_enough_data", "low_power");
    if (calibration.optimisticPower) return rated("not_enough_data", "power_miss");
    return rated("no_clear_link", "no_link");
  }

  const fragile: FragileChecks = { movement: fewMoves(fragility), leaveOneOut: !leaveOneOut || leaveOneOut.flips > 0 };
  if (fragile.movement || fragile.leaveOneOut) return rated("weak", "fragile", fragile);
  if (primary.ci === null) return rated("weak", "no_interval");
  if (primary.p < EVIDENCE.strongP && !calibration.liberalIntervals) return rated("strong", "strong");
  return rated("moderate", "moderate");
}

// ---- A scan's strongest lead ----

/** "Nothing stood out" replaces "No clear link": a scan computes no detectable size, so it can't speak to power. */
export type ScanLeadLevel = Exclude<EvidenceLevel, "no_clear_link"> | "nothing_stood_out";

export type ScanLeadRule =
  /** Doesn't survive BH, with F1. */
  | "few_moves"
  /** Doesn't survive BH. */
  | "not_surviving"
  /** The leave-one-out check is still running. */
  | "pending"
  | "fragile"
  | "no_interval"
  | "strong"
  | "moderate";

export interface ScanLeadRating {
  level: ScanLeadLevel | "pending";
  rule: ScanLeadRule;
  fragile: FragileChecks;
  smallLink: boolean;
}

export interface ScanLeadInput {
  /** The lead's primary test, as its page computes it. */
  primary: TestResult;
  fragility: Fragility | null;
  /** Undefined while it's running; null when it couldn't run. */
  leaveOneOut: LeaveOneOut | null | undefined;
  /** The lead's Benjamini–Hochberg-adjusted p across the scan. */
  bh: number;
  calibration: Calibration;
}

/** The scan's top-ranked tested candidate, rated on its BH-adjusted p (it was picked from many). */
export function scanLeadRating({ primary, fragility, leaveOneOut, bh, calibration }: ScanLeadInput): ScanLeadRating {
  const rated = (level: ScanLeadRating["level"], rule: ScanLeadRule, fragile = NOT_FRAGILE): ScanLeadRating => ({
    level,
    rule,
    fragile,
    smallLink: level !== "pending" && level !== "nothing_stood_out" && smallLink(level, primary),
  });
  if (bh >= ALPHA) return fewMoves(fragility) ? rated("not_enough_data", "few_moves") : rated("nothing_stood_out", "not_surviving");
  if (leaveOneOut === undefined) return rated("pending", "pending");
  const fragile: FragileChecks = { movement: fewMoves(fragility), leaveOneOut: !leaveOneOut || leaveOneOut.flips > 0 };
  if (fragile.movement || fragile.leaveOneOut) return rated("weak", "fragile", fragile);
  if (primary.ci === null) return rated("weak", "no_interval");
  if (bh < EVIDENCE.strongP && !calibration.liberalIntervals) return rated("strong", "strong");
  return rated("moderate", "moderate");
}
