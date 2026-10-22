import { computeChanges, type ChangePoint } from "./changes";
import { primaryFrame } from "./correlation-test";
import { fragility, leaveOneOutSteps, type Fragility, type LeaveOneOut } from "./fragility";
import { ALPHA, type TestResult } from "./inference";
import { adjustedChanges, benchmarkReturnsByT, fitMarketModel, primaryTest, type MarketModel } from "./market-model";
import { benjaminiHochberg, holm } from "./multiple-testing";
import { seededRng, type Rng } from "./random";
import { rowsSince, type ResearchRow, type Resolution } from "./research";
import type { TimePoint } from "./types";
import { drawWeights, wildDraws, wildExceedances, type Frame } from "./wild-bootstrap";

/**
 * A scan: one stock's primary test against many Kalshi candidates, corrected across all of them.
 *
 * Each candidate first gets exactly the primary test its own page computes (the market model,
 * the market-adjusted changes, and 999 wild bootstrap draws), so its r, interval, and p match
 * that page. With 999 draws the smallest p is 0.001, too coarse for Holm's 0.05/m once a scan
 * holds 50 candidates or more, so a candidate whose p is under SCAN_REFINE_BELOW gets a fresh p
 * from SCAN_REFINE_DRAWS draws of its own stream, and the corrections use that. The combination
 * is a valid p-value: for u below the cutoff, p_scan ≤ u needs the fresh p ≤ u; for u at or above
 * it, p_scan ≤ u needs the first p ≤ u. Each of those has probability at most u on its own, so
 * no independence between the two is needed.
 *
 * Holm and Benjamini–Hochberg then run over every candidate with a p-value (those that couldn't
 * be tested don't count toward m: why they couldn't doesn't depend on the stock). While a scan
 * runs, candidates still to come count as p = 1, which makes every adjusted p shown an upper
 * bound on its final value, so a result marked as surviving never stops surviving.
 */

/** Candidates with a first p below this get a finer one. */
export const SCAN_REFINE_BELOW = 0.1;
/** Draws behind a finer p: its smallest value, 1/20,000, is a tenth of 0.05/m at m = 100. */
export const SCAN_REFINE_DRAWS = 19_999;
/** Draws computed per step, so a page can refine in slices. */
export const SCAN_REFINE_CHUNK = 1_000;
/** The most candidates one scan tests: 0.05/200 is still five times the smallest finer p. */
export const MAX_SCAN_CANDIDATES = 200;
/** Leave-one-out runs for this many of the top-ranked results, plus any other survivor up to SCAN_LOO_MAX. */
export const SCAN_LOO_TOP = 5;
export const SCAN_LOO_MAX = 10;

/** One candidate's data, as the panel would compute its window (see windowPlan): the panel's PanelInput without the returns toggle, since a scan is always market-adjusted. */
export interface ScanInput {
  /** The rows the market model is fitted on. */
  full: ResearchRow[];
  /** The window holds the rows after this (ms). */
  from: number;
  resolution: Resolution;
  /** KalshiVariable.scale. */
  scale: number;
  /** The benchmark's closes at the resolution. */
  closes: TimePoint[];
}

/** A finer p-value: SCAN_REFINE_DRAWS fresh draws. */
export interface RefinedP {
  p: number;
  /** Draws computed (all of them, unless a simulation stopped early: see refineSteps). */
  draws: number;
  /** Stopped early: `p` is then a lower bound on the full value. */
  stopped: boolean;
}

export interface ScanTest {
  /** The primary test exactly as the candidate's own page computes it; null without a market model. */
  primary: TestResult | null;
  fragility: Fragility | null;
  /** The finer p, when the first was under SCAN_REFINE_BELOW. */
  refined: RefinedP | null;
  /** The p the corrections use: the finer one when there is one, else the primary test's; null when untested. */
  p: number | null;
}

interface Prepared {
  closesByT: Map<number, number>;
  changes: ChangePoint[];
  model: MarketModel | null;
  abnormal: ChangePoint[] | null;
}

/** The panel's sequence up to the primary test (panelCoreSteps, marketCoreSteps), without the cross-checks a scan doesn't show. */
function prepare({ full, from, scale, closes }: ScanInput): Prepared {
  const closesByT = new Map(closes.map((p) => [p.t, p.value]));
  const changes = computeChanges(rowsSince(full, from), scale).changes;
  const model = fitMarketModel(full, closesByT);
  const abnormal = model && adjustedChanges(changes, benchmarkReturnsByT(full, closesByT), model);
  return { closesByT, changes, model, abnormal };
}

/** The first stage: the primary test exactly as the candidate's page computes it, and the frame to refine it with when due. */
export interface FirstStage {
  primary: TestResult | null;
  fragility: Fragility | null;
  /** The primary test's frame, when its p is under SCAN_REFINE_BELOW. */
  refine: Frame | null;
}

/** The first stage for one candidate (one bootstrap). Simulations skip the fragility diagnostics, which no decision uses. */
export function scanFirstStage(input: ScanInput, { withFragility = true }: { withFragility?: boolean } = {}): FirstStage {
  const { model, abnormal } = prepare(input);
  const primary = model && abnormal ? primaryTest(abnormal, model, input.resolution) : null;
  if (primary?.p == null || !model || !abnormal) return { primary, fragility: null, refine: null };
  return {
    primary,
    fragility: withFragility ? fragility(abnormal, model, input.resolution) : null,
    refine: primary.p < SCAN_REFINE_BELOW ? (primaryFrame(abnormal, input.resolution, model.sample)?.f ?? null) : null,
  };
}

/** One candidate's test, a bootstrap (or a chunk of the finer p's draws) at a time. */
export function* scanCandidateSteps(input: ScanInput, options: RefineOptions = {}): Generator<void, ScanTest> {
  const { primary, fragility: frag, refine } = scanFirstStage(input);
  if (primary?.p == null) return { primary, fragility: null, refined: null, p: null };
  let refined: RefinedP | null = null;
  if (refine) {
    yield;
    refined = yield* refineSteps(refine, options);
  }
  return { primary, fragility: frag, refined, p: refined ? refined.p : primary.p };
}

export interface RefineOptions {
  draws?: number;
  /** The draws' random stream; by default the scan's own, separate from the first test's. */
  rng?: Rng;
  /**
   * Simulations only: stop once the p is sure to end above this (it can then no longer change any
   * decision; see scan-sim.ts). The page always computes every draw.
   */
  stopAbove?: number;
}

/** Weights per draw: one per block of the market model's sample, numbered 0…blocks − 1. */
const blockCount = (f: Frame) => f.block.reduce((max, b) => Math.max(max, b + 1), 0);

/**
 * The p-value for "no relationship" from `draws` fresh draws, SCAN_REFINE_CHUNK at a time.
 * Drawn in chunks from one stream, the weights are the ones a single call would draw, so the
 * p is the same as computing them all at once.
 */
export function* refineSteps(f: Frame, { draws = SCAN_REFINE_DRAWS, rng = seededRng("scan-refine"), stopAbove }: RefineOptions = {}): Generator<void, RefinedP> {
  const blocks = blockCount(f);
  let exceed = 0;
  let valid = 0;
  let done = 0;
  while (done < draws) {
    const n = Math.min(SCAN_REFINE_CHUNK, draws - done);
    const chunk = wildExceedances(f, wildDraws(f, drawWeights(blocks, n, rng)), 0);
    exceed += chunk.exceed;
    valid += chunk.valid;
    done += n;
    // However the remaining draws fall, the p can't end below (1 + exceed) / (1 + draws).
    if (stopAbove !== undefined && done < draws && (1 + exceed) / (1 + draws) > stopAbove) {
      return { p: (1 + exceed) / (1 + draws), draws: done, stopped: true };
    }
    if (done < draws) yield;
  }
  return { p: (1 + exceed) / (1 + valid), draws, stopped: false };
}

/** Leave-one-out (fragility.ts, F3) for one candidate, as its own page runs it. Null when it has no p-value. */
export function* scanLeaveOneOutSteps(input: ScanInput, test: ScanTest): Generator<void, LeaveOneOut | null> {
  if (!test.primary || !test.fragility) return null;
  const { closesByT, changes } = prepare(input);
  return yield* leaveOneOutSteps({
    full: input.full,
    closesByT,
    changes,
    resolution: input.resolution,
    primary: test.primary,
    fragility: test.fragility,
  });
}

// ---- Across the scan ----

export interface Correction {
  holm: number | null;
  bh: number | null;
  survivesHolm: boolean;
  survivesBh: boolean;
}

/**
 * Holm and Benjamini–Hochberg adjusted p-values for the candidates finished so far, with the
 * `pending` candidates still to come counted as p = 1. Finished candidates without a p-value
 * (untested) stay null and don't count. Once nothing is pending, these are the scan's final values;
 * before that, each is an upper bound on its final value.
 */
export function correctScan(ps: (number | null)[], pending = 0): Correction[] {
  const all = [...ps, ...Array.from({ length: pending }, () => 1)];
  const h = holm(all);
  const b = benjaminiHochberg(all);
  return ps.map((_, i) => ({
    holm: h[i],
    bh: b[i],
    survivesHolm: h[i] !== null && h[i]! < ALPHA,
    survivesBh: b[i] !== null && b[i]! < ALPHA,
  }));
}

export interface Rankable {
  /** The scan's p (null: untested, ranked last). */
  p: number | null;
  /** The first test's p, which breaks ties. */
  firstP: number | null;
  /** Breaks remaining ties, so the order never depends on the size of an effect. */
  key: string;
}

const byP = (a: number | null, b: number | null) => (a === null ? (b === null ? 0 : 1) : b === null ? -1 : a - b);

/** Indices of the candidates in rank order: by p (both corrections keep its order), then the first p, then key. */
export function rankScan(items: Rankable[]): number[] {
  return items
    .map((item, i) => ({ item, i }))
    .sort((a, b) => byP(a.item.p, b.item.p) || byP(a.item.firstP, b.item.firstP) || (a.item.key < b.item.key ? -1 : a.item.key > b.item.key ? 1 : 0))
    .map(({ i }) => i);
}

/** Which candidates get leave-one-out: the top SCAN_LOO_TOP tested, then every other survivor, at most SCAN_LOO_MAX. */
export function leaveOneOutTargets(order: number[], tested: (i: number) => boolean, survives: (i: number) => boolean): number[] {
  const ranked = order.filter(tested);
  const targets = ranked.slice(0, SCAN_LOO_TOP);
  for (const i of ranked.slice(SCAN_LOO_TOP)) if (survives(i) && targets.length < SCAN_LOO_MAX) targets.push(i);
  return targets;
}
