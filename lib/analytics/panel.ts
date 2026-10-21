import type { ChangePoint, ChangeSeries } from "./changes";
import { computeChanges } from "./changes";
import { correlationStats, type CorrelationStats } from "./correlation";
import { detectableCorrelation, type DetectableCorrelation, type RefitSample } from "./correlation-test";
import { eventStudy, type EventStudy, type EventStudyOptions } from "./event-study";
import { eventStudyTests, type EventStudyTests } from "./event-tests";
import { ALPHA } from "./inference";
import { crossCorrelation, crossCorrelationSteps, type LagCorrelation } from "./lead-lag";
import { fragility, leaveOneOutSteps, type Fragility, type LeaveOneOut } from "./fragility";
import { combineMarket, marketAdjustment, marketCoreSteps, marketEvents, type MarketAdjustment, type MarketCore, type MarketEvents } from "./market-model";
import { drain } from "./steps";
import { rowsSince, type ResearchRow, type Resolution } from "./research";
import { rollingCorrelation, type RollingPoint } from "./rolling";
import type { TimePoint } from "./types";

// What the Research panel computes for one window, resolution, jump size, and benchmark, as plain
// functions: the panel calls them, and so can tests, benchmarks, and a worker.

const DAY_MS = 24 * 60 * 60 * 1000;

/** The analysis settings that differ by resolution. */
export interface ComputeSettings {
  /** Lags −maxLag…maxLag on the lead-lag chart. */
  maxLag: number;
  rollingWindow: number;
  /** Event-study bars on each side of a jump. */
  eventBars: number;
}

export const COMPUTE_SETTINGS: Record<Resolution, ComputeSettings> = {
  hourly: { maxLag: 3, rollingWindow: 18, eventBars: 6 },
  daily: { maxLag: 5, rollingWindow: 20, eventBars: 5 },
};

/** What the lead-lag, rolling, and event-study cards show. */
export interface View {
  changes: ChangePoint[];
  lags: LagCorrelation[];
  sameInterval: CorrelationStats;
  rolling: RollingPoint[];
  /** Null in market-adjusted mode when beta can't be estimated outside the jump windows. */
  study: EventStudy | null;
  events: EventStudyTests | null;
}

/**
 * Every result one set of changes gives. In market-adjusted mode (`refit` is the market model's
 * sample, refitted in every draw) lag 0 is the primary test, so it's left out of the lead-lag
 * family the other lags are corrected in.
 */
export function researchView(
  changes: ChangePoint[],
  study: EventStudy | null,
  settings: ComputeSettings,
  resolution: Resolution,
  refit: RefitSample | null,
): View {
  const lags = crossCorrelation(changes, settings.maxLag, resolution, refit ? { primaryLag: 0, refit } : {});
  return {
    changes,
    lags,
    sameInterval: lags.find((l) => l.lag === 0)!,
    rolling: rollingCorrelation(changes, settings.rollingWindow),
    study,
    events: study && eventStudyTests(study),
  };
}

/** One window's rows and changes, and the raw-returns view. */
export interface WindowAnalysis {
  /** Every loaded row at the resolution: the market model is fitted on these, whatever the window. */
  full: ResearchRow[];
  rows: ResearchRow[];
  series: ChangeSeries;
  event: EventStudyOptions;
  raw: View;
}

export interface WindowInput {
  /** Every loaded row at the resolution. */
  full: ResearchRow[];
  /** Windows count back from here (ms). */
  asOf: number;
  days: number;
  resolution: Resolution;
  /** The event study's jump size, in the variable's unit. */
  threshold: number;
  /** KalshiVariable.scale. */
  scale: number;
}

export function windowAnalysis({ full, asOf, days, resolution, threshold, scale }: WindowInput): WindowAnalysis {
  const settings = COMPUTE_SETTINGS[resolution];
  const rows = rowsSince(full, asOf - days * DAY_MS);
  const series = computeChanges(rows, scale);
  const event = { threshold, before: settings.eventBars, after: settings.eventBars };
  return { full, rows, series, event, raw: researchView(series.changes, eventStudy(rows, series.changes, event), settings, resolution, null) };
}

/** A benchmark's closes by observation time at the resolution. */
export function closesByTime(points: { hourly: TimePoint[]; daily: TimePoint[] }, resolution: Resolution): Map<number, number> {
  return new Map((resolution === "hourly" ? points.hourly : points.daily).map((p) => [p.t, p.value]));
}

/** Every market-adjusted result for one window (see marketAdjustment). */
export function windowMarket(analysis: WindowAnalysis, closesByT: ReadonlyMap<number, number>, resolution: Resolution, scale: number): MarketAdjustment {
  return marketAdjustment({
    full: analysis.full,
    rows: analysis.rows,
    changes: analysis.series.changes,
    scale,
    closesByT,
    event: analysis.event,
    resolution,
  });
}

/** The market-adjusted view, or null when there's no market model. */
export function adjustedView(market: MarketAdjustment, resolution: Resolution): View | null {
  return market.model && market.abnormal
    ? researchView(market.abnormal, market.studies.abnormal, COMPUTE_SETTINGS[resolution], resolution, market.model.sample)
    : null;
}

/** How large a correlation the primary test could have detected, for a primary result that isn't significant. */
export function primaryDetectable(market: Pick<MarketAdjustment, "primary" | "model" | "abnormal">, resolution: Resolution): DetectableCorrelation | null {
  const { primary } = market;
  return primary?.p != null && primary.p >= ALPHA && market.model && market.abnormal
    ? detectableCorrelation(market.abnormal, resolution, { refit: market.model.sample })
    : null;
}

// ---- The panel's results in two parts, so a change of jump size recomputes only the second ----

/** Raw: the stock's own returns. Adjusted: net of the benchmark (alpha + beta × its return). */
export type Returns = "raw" | "adjusted";

/** Everything one window's results depend on except the event study's jump size. Plain data, so a worker can take it. */
export interface PanelInput {
  /**
   * The rows the market model is fitted on: the last 90 days for windows up to 90 days (as the
   * page loads them), the window itself for longer ones.
   */
  full: ResearchRow[];
  /** The window holds the rows after this (ms). */
  from: number;
  resolution: Resolution;
  /** KalshiVariable.scale. */
  scale: number;
  /** The benchmark's closes at the resolution, or null without a benchmark. */
  closes: TimePoint[] | null;
  /** The returns the charts show; lead-lag tests are run only for those. */
  returns: Returns;
}

/** One window's results that don't depend on the jump size. */
export interface PanelCore {
  rows: ResearchRow[];
  series: ChangeSeries;
  /** Lag 0 on raw returns, for the summary and the raw vs. adjusted table. */
  rawSame: CorrelationStats;
  market: MarketCore | null;
  /** Returns the charts show: market-adjusted when chosen and possible, otherwise raw. */
  shown: Returns;
  lags: LagCorrelation[];
  rolling: RollingPoint[];
  /** The primary test's fragility diagnostics, when it has a p-value (leave-one-out comes later: see panelSecondary). */
  fragility: Fragility | null;
}

const closeMap = (closes: TimePoint[] | null) => closes && new Map(closes.map((p) => [p.t, p.value]));

/**
 * The core results: tests for the lead-lag lags of the returns shown only (they're the costly
 * part), or none with `lags: false` (for the secondary results, which don't need them).
 */
export function panelCore(input: PanelInput, options: { lags?: boolean } = {}): PanelCore {
  return drain(panelCoreSteps(input, options));
}

/** panelCore a bootstrap at a time, so a page can compute a long window in slices; drained, it's panelCore. */
export function* panelCoreSteps({ full, from, resolution, scale, closes, returns }: PanelInput, { lags: withLags = true }: { lags?: boolean } = {}): Generator<void, PanelCore> {
  const settings = COMPUTE_SETTINGS[resolution];
  const rows = rowsSince(full, from);
  const series = computeChanges(rows, scale);
  const closesByT = closeMap(closes);
  const market = closesByT ? yield* marketCoreSteps({ full, changes: series.changes, closesByT, resolution }) : null;
  yield;
  const adjusted = returns === "adjusted" && market?.model && market.abnormal ? { changes: market.abnormal, refit: market.model.sample } : null;
  const changes = adjusted ? adjusted.changes : series.changes;
  const lags = withLags ? yield* crossCorrelationSteps(changes, settings.maxLag, resolution, adjusted ? { primaryLag: 0, refit: adjusted.refit } : {}) : [];
  return {
    rows,
    series,
    rawSame: correlationStats(series.changes.map((c) => ({ x: c.kalshiChange, y: c.logReturn }))),
    market,
    shown: adjusted ? "adjusted" : "raw",
    lags,
    rolling: withLags ? rollingCorrelation(changes, settings.rollingWindow) : [],
    fragility: market?.primary?.p != null && market.model && market.abnormal ? fragility(market.abnormal, market.model, resolution) : null,
  };
}

/** One jump size's results. */
export interface PanelEvents {
  event: EventStudyOptions;
  /** The raw event study (shown in the raw vs. adjusted table whichever returns are shown). */
  rawStudy: EventStudy;
  market: MarketEvents | null;
  /** The shown event study's tests. */
  tests: EventStudyTests | null;
}

export function panelEvents(input: PanelInput, core: PanelCore, threshold: number): PanelEvents {
  const settings = COMPUTE_SETTINGS[input.resolution];
  const event = { threshold, before: settings.eventBars, after: settings.eventBars };
  const { rows, series } = core;
  const rawStudy = eventStudy(rows, series.changes, event);
  const closesByT = closeMap(input.closes);
  const market = closesByT && marketEvents({ full: input.full, rows, changes: series.changes, scale: input.scale, closesByT, event });
  const study = core.shown === "adjusted" ? (market?.studies.abnormal ?? null) : rawStudy;
  return { event, rawStudy, market, tests: study && eventStudyTests(study) };
}

/** What the panel's cards show, from both parts. */
export interface PanelResults {
  rows: ResearchRow[];
  series: ChangeSeries;
  event: EventStudyOptions;
  rawSame: CorrelationStats;
  rawStudy: EventStudy;
  market: MarketAdjustment | null;
  shown: Returns;
  /** The lead-lag, rolling, and event-study cards' view of the returns shown. */
  view: View;
  fragility: Fragility | null;
}

export function panelResults(core: PanelCore, events: PanelEvents): PanelResults {
  const market = core.market && events.market && combineMarket(core.market, events.market);
  const adjusted = core.shown === "adjusted";
  return {
    rows: core.rows,
    series: core.series,
    event: events.event,
    rawSame: core.rawSame,
    rawStudy: events.rawStudy,
    market,
    shown: core.shown,
    view: {
      changes: adjusted ? market!.abnormal! : core.series.changes,
      lags: core.lags,
      sameInterval: core.lags.find((l) => l.lag === 0)!,
      rolling: core.rolling,
      study: adjusted ? market!.studies.abnormal : events.rawStudy,
      events: events.tests,
    },
    fragility: core.fragility,
  };
}

/** The results computed after the main ones, since they cost several times as much: the detectable size and the leave-one-out check. */
export interface PanelSecondary {
  detectable: DetectableCorrelation | null;
  leaveOneOut: LeaveOneOut | null;
}

/** The detectable size, for a primary result that isn't significant. */
export function secondaryDetectable(core: PanelCore, resolution: Resolution): DetectableCorrelation | null {
  return core.market ? primaryDetectable(core.market, resolution) : null;
}

/** The primary test without each of its most influential sessions (fragility.ts). */
export function secondaryLeaveOneOut(input: PanelInput, core: PanelCore): LeaveOneOut | null {
  return drain(secondaryLeaveOneOutSteps(input, core));
}

/** secondaryLeaveOneOut a rerun at a time. */
export function* secondaryLeaveOneOutSteps(input: PanelInput, core: PanelCore): Generator<void, LeaveOneOut | null> {
  const closesByT = closeMap(input.closes);
  if (!core.fragility || !core.market?.primary || !closesByT) return null;
  return yield* leaveOneOutSteps({
    full: input.full,
    closesByT,
    changes: core.series.changes,
    resolution: input.resolution,
    primary: core.market.primary,
    fragility: core.fragility,
  });
}
