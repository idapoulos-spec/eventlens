import type { ChangePoint } from "./changes";
import { blockKey, primaryFrame, type BlockLayout } from "./correlation-test";
import { ALPHA, type TestResult } from "./inference";
import { adjustedChanges, benchmarkReturnsByT, fitMarketModel, primaryTest, type MarketModel } from "./market-model";
import type { ResearchRow, Resolution } from "./research";
import { MIN_BOOTSTRAP_BLOCKS, MIN_KALSHI_MOVES } from "./sample";
import { drain } from "./steps";

/**
 * How much the primary test rests on a few intervals or sessions (fed-history's post-hoc
 * diagnostics, made routine). Everything comes from the test's own frame (wild-bootstrap.ts):
 * x̌ is the Kalshi change net of its mean, a the market model's residual (the abnormal return),
 * and q = M₁x̌ (x̌ net of what the market model would absorb). An interval's term is c = q·a, and
 * Σc = θ̂·Σx̌², so c says how much the interval pushes the estimate. A session's score is
 * s = Σc over its intervals; under the null the bootstrap's numerator is Σ s·w with one Webb weight
 * w per session (mean 0, variance 1), so its variance is Σs², and s²/Σs² is the session's share of it.
 *
 * Effective counts are Kish's (Σw)²/Σw²: how many equally weighted items the weights are worth.
 * - Kalshi movement: the slope is a weighted mean of per-interval slopes a/x̌ with weights x̌²/Σx̌²,
 *   so 1/Σ(x̌²/Σx̌²)² is how many equal intervals of movement the estimate rests on.
 * - Sessions: 1/Σshare² is how many equal sessions drive the bootstrap's distribution, in the
 *   spirit of an effective number of clusters (Carter, Schnepel & Steigerwald 2017; MacKinnon &
 *   Webb 2017 on wild cluster bootstraps with unbalanced clusters).
 */

/**
 * The fragile warning's thresholds, fixed before any result was seen (the feat/long-windows plan,
 * 2026-10-14). F1 and F3 are unchanged since.
 *
 * Changed on 2026-10-19: F2 (fewer than MIN_BOOTSTRAP_BLOCKS effective sessions) is no longer part
 * of the warning; the effective number of sessions is still shown, as a description. In null
 * simulations F2 fired in 98.5% of data sets at 90 days and 61% at a year (fragility-rates.test.ts),
 * because most sessions have no Kalshi movement, so the score always sits in a few of them and the
 * check carried no information as a warning. Decided on simulated data only, not on any real result.
 */
export const FRAGILE = {
  /** F1: the estimate rests on fewer equal intervals of Kalshi movement than the page's existing "a few moves decide" rule. */
  minEffectiveMoves: MIN_KALSHI_MOVES,
  /** F3: leaving out any one of this many most influential sessions changes the decision. */
  leaveOut: 10,
} as const;

/** The pre-set F2 cutoff, now descriptive only: the page's minimum sessions for a p-value at all. */
export const DESCRIPTIVE_MIN_SESSIONS = MIN_BOOTSTRAP_BLOCKS;

/** Kish's effective number of equally weighted items: (Σw)² / Σw². */
export function effectiveCount(weights: ArrayLike<number>): number {
  let sum = 0;
  let squares = 0;
  for (let i = 0; i < weights.length; i++) {
    sum += weights[i];
    squares += weights[i] * weights[i];
  }
  return squares > 0 ? (sum * sum) / squares : 0;
}

/** Share of `total` held by the k largest of `values`, which are sorted largest first. */
const topShare = (values: number[], total: number, k: number) => values.slice(0, k).reduce((a, b) => a + b, 0) / total;

/** A session (hourly) or run of trading days (daily): one bootstrap weight. */
export interface InfluentialSession {
  /** Its block key (blockKey): which intervals are in it. */
  key: number;
  /** When its first and last intervals in the market model's sample ended (ms). */
  from: number;
  to: number;
  /** Σ q·a over its intervals: positive pushes the estimate up. */
  score: number;
  /** s² / Σs²: its share of the bootstrap's score variance. */
  share: number;
  /** Its intervals in the selected window. */
  windowIntervals: number;
}

/** One interval of the window, among those that push the estimate most. */
export interface InfluentialHour {
  /** When it ended (ms); it started one grid slot earlier. */
  t: number;
  kalshiChange: number;
  /** The abnormal log return: the stock's return net of the market model. */
  abnormal: number;
  /** q·a, its term in the estimate's numerator: positive pushes it up. */
  contribution: number;
  /** contribution² / Σ contribution² over the market model's sample. */
  share: number;
  /** Its session's rank by share; 1 is the most influential. */
  sessionRank: number;
}

export interface Fragility {
  unit: BlockLayout["unit"];
  /** How the sessions were keyed, so leaveOneOut can drop exactly them. */
  blocking: { first: number; runDays: number | null };
  movement: {
    intervals: number;
    /** Intervals in which Kalshi moved. */
    moves: number;
    /** Shares of Σx̌² held by the largest interval and the largest 5. */
    top1: number;
    top5: number;
    effective: number;
  };
  sessions: {
    /** Sessions (or runs of days) in the market model's sample: each gets a weight. */
    count: number;
    top1: number;
    top5: number;
    top10: number;
    effective: number;
    /** The FRAGILE.leaveOut most influential, largest share first. */
    ranked: InfluentialSession[];
  };
  /** The window's 10 intervals that push the estimate most. */
  hours: InfluentialHour[];
}

/** The primary test's diagnostics from its inputs (marketAdjustment's abnormal changes and model); null when its frame can't be built. */
export function fragility(abnormal: ChangePoint[], model: MarketModel, resolution: Resolution): Fragility | null {
  const pf = primaryFrame(abnormal, resolution, model.sample);
  if (!pf) return null;
  const { f, sorted, layout } = pf;
  const { sample } = model;
  const first = sorted.length > 0 ? sorted[0].step : 0;
  const keyOf = (i: number) => blockKey(sample.t[i], sample.step[i], first, layout.runDays);

  const weights = Array.from(f.xc, (v) => (v * v) / f.sxx);
  const descending = [...weights].sort((a, b) => b - a);

  const contribution = Float64Array.from({ length: f.n }, (_, t) => f.q[t] * f.a[t]);
  const byKey = new Map<number, InfluentialSession>();
  for (let t = 0; t < f.n; t++) {
    const key = keyOf(t);
    const s = byKey.get(key) ?? { key, from: sample.t[t], to: sample.t[t], score: 0, share: 0, windowIntervals: 0 };
    s.score += contribution[t];
    s.from = Math.min(s.from, sample.t[t]);
    s.to = Math.max(s.to, sample.t[t]);
    byKey.set(key, s);
  }
  for (let p = 0; p < f.m; p++) byKey.get(keyOf(f.index[p]))!.windowIntervals++;
  const sessions = [...byKey.values()];
  const total = sessions.reduce((sum, s) => sum + s.score * s.score, 0);
  for (const s of sessions) s.share = total > 0 ? (s.score * s.score) / total : 0;
  sessions.sort((a, b) => b.share - a.share || a.from - b.from);
  const shares = sessions.map((s) => s.share);
  const rank = new Map(sessions.map((s, i) => [s.key, i + 1]));

  const c2 = contribution.reduce((sum, v) => sum + v * v, 0);
  const hours = Array.from({ length: f.m }, (_, p) => p)
    .sort((a, b) => Math.abs(contribution[f.index[b]]) - Math.abs(contribution[f.index[a]]) || sorted[a].t - sorted[b].t)
    .slice(0, 10)
    .map((p) => {
      const j = f.index[p];
      return {
        t: sorted[p].t,
        kalshiChange: sorted[p].kalshiChange,
        abnormal: f.a[j],
        contribution: contribution[j],
        share: c2 > 0 ? (contribution[j] * contribution[j]) / c2 : 0,
        sessionRank: rank.get(keyOf(j))!,
      };
    });

  return {
    unit: layout.unit,
    blocking: { first, runDays: layout.runDays },
    movement: {
      intervals: f.m,
      moves: sorted.filter((c) => c.kalshiChange !== 0).length,
      top1: topShare(descending, 1, 1),
      top5: topShare(descending, 1, 5),
      effective: effectiveCount(weights),
    },
    sessions: {
      count: sessions.length,
      top1: topShare(shares, 1, 1),
      top5: topShare(shares, 1, 5),
      top10: topShare(shares, 1, 10),
      effective: effectiveCount(shares),
      ranked: sessions.slice(0, FRAGILE.leaveOut),
    },
    hours,
  };
}

// ---- Leaving out the most influential sessions ----

/** The primary test rerun without one session. */
export interface LeaveOneOutRun {
  session: InfluentialSession;
  /** 1 is the most influential. */
  rank: number;
  test: TestResult;
  /** The decision at 5% differs from the primary test's (see decisionFlips). */
  flips: boolean;
}

export interface LeaveOneOut {
  runs: LeaveOneOutRun[];
  /** Every one of them left out at once: informative only, not part of the warning. */
  together: TestResult;
  /** Range of the reruns' estimates and p-values (those that have one). */
  estimate: [number, number] | null;
  p: [number, number] | null;
  /** Reruns whose decision differs from the primary test's. */
  flips: number;
  /** Reruns too small for a p-value (fewer than 8 sessions left). */
  unavailable: number;
}

export interface LeaveOneOutInput {
  /** Every loaded row at the resolution: the market model's sample comes from these. */
  full: ResearchRow[];
  closesByT: ReadonlyMap<number, number>;
  /** The window's usable changes (raw returns), before adjustment. */
  changes: ChangePoint[];
  resolution: Resolution;
  /** The primary test on all the data. */
  primary: TestResult;
  fragility: Fragility;
  draws?: number;
}

/**
 * Whether a rerun reaches a different decision at 5% than the primary test: p crosses 0.05 either
 * way, or a significant estimate changes sign. A rerun without a p-value decides nothing.
 */
export function decisionFlips(primary: TestResult, rerun: TestResult): boolean {
  if (primary.p === null || rerun.p === null) return false;
  const significant = primary.p < ALPHA;
  if ((rerun.p < ALPHA) !== significant) return true;
  return significant && Math.sign(rerun.estimate ?? 0) !== Math.sign(primary.estimate ?? 0);
}

/**
 * The primary test rerun from the start without some sessions, as if they were missing: their
 * intervals leave the market model's sample (so alpha and beta are refitted without them) and the
 * window, then the same test runs on what's left. Null when no market model can be fitted.
 */
export function primaryWithout(
  { full, closesByT, changes, resolution, fragility: { blocking } }: Omit<LeaveOneOutInput, "primary">,
  keys: ReadonlySet<number>,
  draws?: number,
): TestResult | null {
  const dropped = (t: number, step: number) => keys.has(blockKey(t, step, blocking.first, blocking.runDays));
  const model = fitMarketModel(full, closesByT, (i) => dropped(full[i].t, full[i].step));
  if (!model) return null;
  const kept = changes.filter((c) => !dropped(c.t, c.step));
  return primaryTest(adjustedChanges(kept, benchmarkReturnsByT(full, closesByT), model), model, resolution, { draws });
}

const unavailable = (base: TestResult): TestResult => ({ ...base, p: null, ci: null, estimate: null, pUnavailable: "unstable", ciUnavailable: "unstable" });

/** The primary test without each of its FRAGILE.leaveOut most influential sessions in turn (ranked before any rerun), then without them all. */
export function leaveOneOut(input: LeaveOneOutInput): LeaveOneOut {
  return drain(leaveOneOutSteps(input));
}

/** leaveOneOut a rerun at a time, so a page can compute it in slices. */
export function* leaveOneOutSteps(input: LeaveOneOutInput): Generator<void, LeaveOneOut> {
  const { primary, fragility: frag, draws } = input;
  const runs: LeaveOneOutRun[] = [];
  for (const [i, session] of frag.sessions.ranked.entries()) {
    const test = primaryWithout(input, new Set([session.key]), draws) ?? unavailable(primary);
    runs.push({ session, rank: i + 1, test, flips: decisionFlips(primary, test) });
    yield;
  }
  const together = primaryWithout(input, new Set(frag.sessions.ranked.map((s) => s.key)), draws) ?? unavailable(primary);
  const range = (values: number[]): [number, number] | null => (values.length ? [Math.min(...values), Math.max(...values)] : null);
  const tested = runs.filter((r) => r.test.p !== null);
  return {
    runs,
    together,
    estimate: range(runs.flatMap((r) => (r.test.estimate === null ? [] : [r.test.estimate]))),
    p: range(tested.map((r) => r.test.p!)),
    flips: runs.filter((r) => r.flips).length,
    unavailable: runs.length - tested.length,
  };
}

/** Which of the warning's checks trip: F1 movement, F3 leave-one-out (only once it has run). F2 is descriptive since 2026-10-19 (see FRAGILE). */
export type FragileReason = "movement" | "leave_one_out";

export function fragileReasons(f: Fragility, loo: LeaveOneOut | null): FragileReason[] {
  const reasons: FragileReason[] = [];
  if (f.movement.effective < FRAGILE.minEffectiveMoves) reasons.push("movement");
  if (loo && loo.flips > 0) reasons.push("leave_one_out");
  return reasons;
}
