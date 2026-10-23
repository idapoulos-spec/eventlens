// One candidate's ScanInput: its rows built as its page builds them (components/Research.tsx,
// components/event/EventDashboard.tsx), then the window read as the panel reads it (windowPlan).
// Pure, so the browser does it.

import type { Resolution } from "@/lib/analytics/research";
import { rowsSince } from "@/lib/analytics/research";
import type { ScanInput } from "@/lib/analytics/scan";
import { eventLongRows, eventResearchRows, lastRows, marketLongRows, marketResearchRows, rowsOverlap, type LongRows, type ResearchRows } from "@/lib/history/rows";
import { STOCK_HISTORY_MS, windowPlan, type WindowChoice } from "@/lib/history/window";
import { benchmarkFrom } from "@/lib/market-data/benchmark-series";
import type { BenchmarkSeries } from "@/lib/market-data/types";
import { fail, ok, type Result } from "@/lib/result";
import { candidateBars, type ScanStock } from "./bars";
import type { ScanKalshi } from "./types";

const DAY_MS = 24 * 60 * 60 * 1000;
/** A Kalshi probability changes in percentage points (probabilityVariable); an expected value in its own unit (expectedVariable). */
const SCALE = { market: 100, event: 1 } as const;
const NO_PROVENANCE = { storedThrough: null, liveFrom: null, liveFailed: false };

/** What one candidate's test reads, and how its window came out. */
export interface CandidateInput {
  input: ScanInput;
  /** Where the window ends (ms): its close, or when the stock's bars were fetched. */
  asOf: number;
  /** A longer window that's no longer than 90 days for this candidate, so it's the 90-day one. */
  sameAs90: boolean;
}

export function candidateInput(stock: ScanStock, benchmark: BenchmarkSeries, kalshi: ScanKalshi, choice: WindowChoice, chosen: Resolution): Result<CandidateInput> {
  const { research, fetchedAt } = candidateBars(stock, kalshi);
  let rows: ResearchRows;
  let long: LongRows | null = null;
  if (kalshi.kind === "market") {
    if (kalshi.points.length === 0) return fail("no_history", "Kalshi has no price history for it in the 90 days to its end.");
    rows = marketResearchRows({ kalshi: kalshi.points, closeTime: kalshi.closeTime, research, fetchedAt });
    if (kalshi.long) {
      long = marketLongRows({ history: { ...kalshi.long, provenance: NO_PROVENANCE }, closeTime: kalshi.closeTime, research, fetchedAt });
    }
  } else {
    rows = eventResearchRows({ marks: kalshi.marks, research, fetchedAt });
    if (kalshi.long) long = eventLongRows({ marks: kalshi.long.marks, start: kalshi.long.start, research, fetchedAt });
  }
  if (!rowsOverlap(rows)) return fail("no_overlap", "Its Kalshi history and the stock's prices don't overlap while it was trading.");

  const { hourly, daily, asOf } = lastRows(rows);
  const resolution: Resolution = choice === 7 ? "hourly" : chosen;
  // As the page hands the panel its benchmark: from where Research can read it.
  const bench = benchmarkFrom(benchmark, Math.min(research.longStart, asOf - STOCK_HISTORY_MS));
  const closes = resolution === "hourly" ? bench.hourly : bench.daily;
  const scale = SCALE[kalshi.kind];
  const plan = windowPlan(choice, ok(long), asOf);
  if (plan.kind === "long") {
    const full = rowsSince(resolution === "hourly" ? plan.rows.hourly : plan.rows.daily, plan.from);
    return ok({ input: { full, from: -Infinity, resolution, scale, closes }, asOf, sameAs90: false });
  }
  if (plan.kind !== "loaded") return fail("unavailable", "Its longer history couldn't be read.");
  const full = resolution === "hourly" ? hourly : daily;
  return ok({ input: { full, from: asOf - plan.days * DAY_MS, resolution, scale, closes }, asOf, sameAs90: plan.sameAs90 });
}
