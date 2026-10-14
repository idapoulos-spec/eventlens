import type { ChangePoint, ChangeSeries } from "./changes";
import { computeChanges } from "./changes";
import type { CorrelationStats } from "./correlation";
import { detectableCorrelation, type DetectableCorrelation, type RefitSample } from "./correlation-test";
import { eventStudy, type EventStudy, type EventStudyOptions } from "./event-study";
import { eventStudyTests, type EventStudyTests } from "./event-tests";
import { ALPHA } from "./inference";
import { crossCorrelation, type LagCorrelation } from "./lead-lag";
import { marketAdjustment, type MarketAdjustment } from "./market-model";
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
export function primaryDetectable(market: MarketAdjustment, resolution: Resolution): DetectableCorrelation | null {
  const { primary } = market;
  return primary?.p != null && primary.p >= ALPHA && market.model && market.abnormal
    ? detectableCorrelation(market.abnormal, resolution, { refit: market.model.sample })
    : null;
}
