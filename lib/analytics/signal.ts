// DISPLAY_TIME_ZONE is New York; the lib/market-data index also loads the server-only Twelve Data client, so session is imported directly.
import { DISPLAY_TIME_ZONE } from "@/lib/format";
import { timeZoneOffsetMs } from "@/lib/market-data/session";
import type { ChangePoint } from "./changes";
import { blockKey } from "./correlation-test";
import { scanLeadRating, type Calibration, type EvidenceLevel, type EvidenceRating, type ScanLeadRating } from "./evidence";
import { lagFragility, type Fragility, type LeaveOneOut, type LeaveOneOutRun } from "./fragility";
import { passes, type TestResult } from "./inference";
import { crossCorrelationSteps, type LagCorrelation } from "./lead-lag";
import { adjustedChanges, benchmarkReturnsByT, fitMarketModel, type MarketModel } from "./market-model";
import { HOUR_MS } from "./probability";
import type { ResearchRow, Resolution } from "./research";
import { drain } from "./steps";

/**
 * The experimental signal: "Leans Buy vs. <benchmark>", "Leans Sell vs. <benchmark>", or "Hold: no
 * signal". A Buy or Sell implies the stock moves next, so it rests only on Kalshi moving first: the
 * corrected lead-lag test's Kalshi-first lead, rated by the scan-lead rules on its own pairs and a
 * leave-one-out rerun of the whole lead-lag family, never above the card's own rating, and a recent
 * Kalshi move the lead hasn't played out yet. The rules (S1–S10) were fixed on 2026-11-16 and written
 * into the README ("The experimental signal") before any code or simulation of them ran; they're not
 * tuned to any result. The first rule that matches decides. signal-rates.sim.test.ts checks how often
 * a label comes up.
 */

export const SIGNAL = {
  /** Hourly: a pending interval's partner hour must end by this hour, New York time, the same day (early closes aren't modelled). */
  closeHour: 16,
  /** The recent move is shown, and compared with the jump size, to this many decimals. */
  moveDigits: 1,
} as const;

/** What the signal says. */
export type SignalLabel = "buy" | "sell" | "hold" | "pending";

/** The README's rules S1–S10. */
export type SignalRule =
  /** S1: no market-adjusted lead-lag results (Returns is Raw, or no market model). */
  | "no_adjusted"
  /** S2: no lag in the family has a p-value. */
  | "no_p"
  /** S3: no Kalshi-first lag passes BH. */
  | "no_lead"
  /** S4: a stock-first lag passes BH too. */
  | "both_ways"
  /** S5: the lead's checks or the card's rating are still computing. */
  | "pending"
  /** S6: the lead is rated Weak. */
  | "weak_lead"
  /** S7: the card's badge is below Moderate. */
  | "badge"
  /** S8: no pending interval (hourly: the lead can't play out by 4 PM). */
  | "too_late"
  /** S9: the recent move, as shown, is smaller than the jump size. */
  | "no_move"
  /** S10. */
  | "lean";

/** The signal's evidence level: the card's levels, plus "No clear lead" when no Kalshi-first lead can be used. */
export type SignalLevel = EvidenceLevel | "no_clear_lead" | "pending" | "none";

/** Which side moves first in the corrected lead-lag results. */
export type FirstMover = "kalshi" | "stock" | "both" | "neither" | "untested";

/** Kalshi's change in the intervals the lead hasn't played out yet. */
export interface RecentMove {
  /** The lead's k: the move is over the window's last k slots that still count. */
  lag: number;
  /** Slots that count: the last k (daily), or those whose partner hour ends by the close (hourly). */
  slots: number;
  /** The sum of Kalshi's usable changes in them, as shown (SIGNAL.moveDigits). */
  value: number;
  /** |value| ≥ the jump size. */
  enough: boolean;
}

/** The lead's own diagnostics: F1 and its session ranking, and the leave-one-out reruns of the family. */
export interface SignalCheck {
  fragility: Fragility | null;
  leaveOneOut: LeaveOneOut | null;
}

export interface SignalInput {
  /** The market-adjusted lead-lag family as the page shows it, or null when the page shows raw returns. */
  lags: LagCorrelation[] | null;
  /** The card's rating (its badge). */
  card: EvidenceRating["level"];
  /** The lead's check: undefined while it's computing, null when it couldn't run. */
  check: SignalCheck | null | undefined;
  calibration: Calibration;
  /** The window's usable changes (market-adjusted, as the lags use them). */
  changes: ChangePoint[];
  /** The window's last row: the signal is worked out there. */
  end: Pick<ResearchRow, "t" | "step"> | null;
  resolution: Resolution;
  /** The event study's jump size, in the variable's unit. */
  threshold: number;
}

export interface SignalDecision {
  label: SignalLabel;
  rule: SignalRule;
  level: SignalLevel;
  first: FirstMover;
  /** The Kalshi-first lead, when one passes. */
  lead: LagCorrelation | null;
  /** The lead's rating by the scan-lead rules, once its check is in. */
  leadRating: ScanLeadRating | null;
  /** The recent move over the lead's pending intervals, when there's a lead. */
  move: RecentMove | null;
}

// ---- The lead ----

/** The tested lags and those passing BH on each side, by smallest p: the "Does Kalshi move first?" tile's reading. */
export function leadOf(lags: LagCorrelation[]): { tested: LagCorrelation[]; kalshiFirst: LagCorrelation | null; stockFirst: LagCorrelation | null; first: FirstMover } {
  const tested = lags.filter((l) => l.test.role === "exploratory" && l.test.p !== null);
  // Stable: lags are in order −k…k, so a tie in p goes to the shorter Kalshi-first lag.
  const passing = tested.filter((l) => l.lag !== 0 && passes(l.test, "bh")).sort((a, b) => a.test.p! - b.test.p!);
  const kalshiFirst = passing.find((l) => l.lag > 0) ?? null;
  const stockFirst = passing.find((l) => l.lag < 0) ?? null;
  const first: FirstMover =
    tested.length === 0 ? "untested" : kalshiFirst && stockFirst ? "both" : kalshiFirst ? "kalshi" : stockFirst ? "stock" : "neither";
  return { tested, kalshiFirst, stockFirst, first };
}

// ---- The recent move ----

const DAY_MS = 24 * HOUR_MS;

/** When the regular session closes (SIGNAL.closeHour, New York) on the New York date of `t`. */
export function closeOnDateOf(t: number): number {
  const local = t + timeZoneOffsetMs(t, DISPLAY_TIME_ZONE);
  const guess = local - (((local % DAY_MS) + DAY_MS) % DAY_MS) + SIGNAL.closeHour * HOUR_MS;
  // Afternoon times are never near a DST switch, so one offset correction is exact.
  return guess - timeZoneOffsetMs(guess, DISPLAY_TIME_ZONE);
}

/**
 * The window's last k grid slots whose partner, k slots later, is still to come: every one daily;
 * hourly, only those whose partner hour ends by the close the same day, since a lead never pairs
 * hours across a close.
 */
export function pendingSlots(end: Pick<ResearchRow, "t" | "step">, lag: number, resolution: Resolution): number[] {
  const slots: number[] = [];
  for (let step = end.step - lag + 1; step <= end.step; step++) {
    if (resolution === "hourly") {
      const t = step * HOUR_MS;
      if ((step + lag) * HOUR_MS > closeOnDateOf(t)) continue;
    }
    slots.push(step);
  }
  return slots;
}

/** A value as shown to SIGNAL.moveDigits decimals, with no negative zero. */
export const shownMove = (v: number) => Number(v.toFixed(SIGNAL.moveDigits)) || 0;

/** Kalshi's net change over the lead's pending slots, as shown, and whether it reaches the jump size. */
export function recentMove(changes: ChangePoint[], end: Pick<ResearchRow, "t" | "step">, lag: number, resolution: Resolution, threshold: number): RecentMove {
  const slots = new Set(pendingSlots(end, lag, resolution));
  let sum = 0;
  for (const c of changes) if (slots.has(c.step)) sum += c.kalshiChange;
  const value = shownMove(sum);
  return { lag, slots: slots.size, value, enough: Math.abs(value) >= threshold };
}

// ---- The decision ----

const RANK: Partial<Record<SignalLevel, number>> = { weak: 1, moderate: 2, strong: 3 };

export function signalDecision({ lags, card, check, calibration, changes, end, resolution, threshold }: SignalInput): SignalDecision {
  const decided = (rule: SignalRule, level: SignalLevel, rest: Partial<SignalDecision> = {}): SignalDecision => ({
    label: rule === "pending" ? "pending" : "hold",
    rule,
    level,
    first: "untested",
    lead: null,
    leadRating: null,
    move: null,
    ...rest,
  });
  if (lags === null) return decided("no_adjusted", "none");
  const { kalshiFirst: lead, first } = leadOf(lags);
  if (first === "untested") return decided("no_p", "not_enough_data");
  if (!lead) return decided("no_lead", "no_clear_lead", { first });
  if (first === "both") return decided("both_ways", "no_clear_lead", { first, lead });

  const move = end ? recentMove(changes, end, lead.lag, resolution, threshold) : null;
  const known = { first, lead, move };
  if (check === undefined || card === "pending") return decided("pending", "pending", known);
  const leadRating = scanLeadRating({
    primary: lead.test,
    fragility: check?.fragility ?? null,
    leaveOneOut: check?.leaveOneOut ?? null,
    bh: lead.test.bh ?? 1,
    calibration,
  });
  const rated = { ...known, leadRating };
  // The lead passes BH and its check is in, so its rating is Weak, Moderate, or Strong.
  if (leadRating.level !== "moderate" && leadRating.level !== "strong") return decided("weak_lead", "weak", rated);
  const cardRank = RANK[card] ?? 0;
  if (cardRank < RANK.moderate!) return decided("badge", card, rated);
  // Never stronger than the badge.
  const level: SignalLevel = cardRank < RANK[leadRating.level]! ? card : leadRating.level;
  if (!move || move.slots === 0) return decided("too_late", level, rated);
  const direction = Math.sign(lead.test.estimate ?? 0) * Math.sign(move.value);
  if (!move.enough || direction === 0) return decided("no_move", level, rated);
  return { ...decided("lean", level, rated), label: direction > 0 ? "buy" : "sell" };
}

// ---- The lead's leave-one-out check ----

export interface LeadCheckInput {
  /** Every loaded row at the resolution: the market model's sample comes from these. */
  full: ResearchRow[];
  closesByT: ReadonlyMap<number, number>;
  /** The window's usable changes (raw returns), before adjustment. */
  changes: ChangePoint[];
  /** The market-adjusted changes and their model, as the page computed them. */
  abnormal: ChangePoint[];
  model: MarketModel;
  resolution: Resolution;
  /** The lead's k and its test as the page shows it. */
  lag: number;
  lead: TestResult;
  /** The lead-lag family's −maxLag…maxLag. */
  maxLag: number;
  draws?: number;
}

/** Whether a rerun reaches a different decision than the lead: its BH-adjusted p crosses 0.05, or a passing correlation changes sign. */
export function leadFlips(lead: TestResult, rerun: TestResult): boolean {
  if (lead.p === null || rerun.p === null) return false;
  const passing = passes(lead, "bh");
  if (passes(rerun, "bh") !== passing) return true;
  return passing && Math.sign(rerun.estimate ?? 0) !== Math.sign(lead.estimate ?? 0);
}

/**
 * The lead's test after rerunning the whole lead-lag family without some sessions, as if they were
 * missing: they leave the market model's sample (alpha and beta are refitted) and the window, then
 * every lag is tested again and corrected together, as on the page. Null when no market model fits.
 */
export function* leadWithoutSteps(
  { full, closesByT, changes, resolution, lag, maxLag, draws }: Omit<LeadCheckInput, "abnormal" | "model" | "lead">,
  blocking: Fragility["blocking"],
  keys: ReadonlySet<number>,
): Generator<void, TestResult | null> {
  const dropped = (t: number, step: number) => keys.has(blockKey(t, step, blocking.first, blocking.runDays));
  const model = fitMarketModel(full, closesByT, (i) => dropped(full[i].t, full[i].step));
  if (!model) return null;
  const kept = changes.filter((c) => !dropped(c.t, c.step));
  const abnormal = adjustedChanges(kept, benchmarkReturnsByT(full, closesByT), model);
  // A pause after the refit, so no step holds both it and a bootstrap.
  yield;
  const family = yield* crossCorrelationSteps(abnormal, maxLag, resolution, { primaryLag: 0, refit: model.sample, draws });
  return family.find((l) => l.lag === lag)?.test ?? null;
}

const unavailable = (base: TestResult): TestResult => ({ ...base, p: null, ci: null, estimate: null, holm: null, bh: null, pUnavailable: "unstable", ciUnavailable: "unstable" });

/**
 * The lead's diagnostics (lagFragility on its own pairs) and its leave-one-out check: the family
 * rerun without each of the lead's FRAGILE.leaveOut most influential sessions in turn (ranked before
 * any rerun), then without them all. A step per lag tested, so a page can compute it in slices.
 */
export function* signalCheckSteps(input: LeadCheckInput): Generator<void, SignalCheck> {
  const { abnormal, model, resolution, lag, lead } = input;
  const fragility = lagFragility(abnormal, model, resolution, lag);
  yield;
  if (!fragility) return { fragility: null, leaveOneOut: null };
  const runs: LeaveOneOutRun[] = [];
  for (const [i, session] of fragility.sessions.ranked.entries()) {
    const test = (yield* leadWithoutSteps(input, fragility.blocking, new Set([session.key]))) ?? unavailable(lead);
    runs.push({ session, rank: i + 1, test, flips: leadFlips(lead, test) });
  }
  const all = new Set(fragility.sessions.ranked.map((s) => s.key));
  const together = (yield* leadWithoutSteps(input, fragility.blocking, all)) ?? unavailable(lead);
  const range = (values: number[]): [number, number] | null => (values.length ? [Math.min(...values), Math.max(...values)] : null);
  const tested = runs.filter((r) => r.test.p !== null);
  return {
    fragility,
    leaveOneOut: {
      runs,
      together,
      estimate: range(runs.flatMap((r) => (r.test.estimate === null ? [] : [r.test.estimate]))),
      p: range(tested.map((r) => r.test.p!)),
      flips: runs.filter((r) => r.flips).length,
      unavailable: runs.length - tested.length,
    },
  };
}

export function signalCheck(input: LeadCheckInput): SignalCheck {
  return drain(signalCheckSteps(input));
}
