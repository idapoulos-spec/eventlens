// Research's rows: the stock's observations with Kalshi's value in effect at each (one market's
// probability, or an event's expected value). Pure, so the pages and the tests build them the same way.

import { buildExpectedRows, buildResearchRows, rowsSince, type ExpectedPoint, type ResearchRow, type SourcedPoint } from "@/lib/analytics/research";
import type { LongHistory, ResearchBars } from "./types";
import { RESEARCH_WINDOW_MS, researchStockPoints, settledAt } from "./window";

/** Hourly and daily rows, and where Research's windows count back from. */
export interface ResearchRows {
  hourly: ResearchRow[];
  daily: ResearchRow[];
  /** Windows end here (ms): a closed market's close, or when the stock's bars were fetched. */
  asOf: number;
}

interface StockSide {
  /** The stock's bars for Research. */
  research: ResearchBars;
  /** When the bars were fetched: bars that hadn't closed by then may still have been forming (see settledAt for a frozen window). */
  fetchedAt: number;
}

/** One market's rows, from its probability points and its close time. */
export function marketResearchRows({
  kalshi,
  closeTime,
  research,
  fetchedAt,
}: StockSide & { kalshi: SourcedPoint[]; closeTime: number | null }): ResearchRows {
  const stock = researchStockPoints({ ...research, fetchedAt: settledAt(research, fetchedAt) });
  return {
    hourly: buildResearchRows({ kalshi, closeTime, stock: stock.hourly, resolution: "hourly" }),
    daily: buildResearchRows({ kalshi, closeTime, stock: stock.daily, resolution: "daily" }),
    asOf: research.end ?? fetchedAt,
  };
}

/** An event's rows, each reading E at its own mark. */
export function eventResearchRows({ marks, research, fetchedAt }: StockSide & { marks: ExpectedPoint[] }): ResearchRows {
  const stock = researchStockPoints({ ...research, fetchedAt: settledAt(research, fetchedAt) });
  return {
    hourly: buildExpectedRows({ stock: stock.hourly, marks, resolution: "hourly" }),
    daily: buildExpectedRows({ stock: stock.daily, marks, resolution: "daily" }),
    asOf: research.end ?? fetchedAt,
  };
}

/** Whether Kalshi and the stock overlap anywhere: some row, hourly or daily, is usable. */
export function rowsOverlap({ hourly, daily }: ResearchRows): boolean {
  return hourly.some((r) => r.exclusion === null) || daily.some((r) => r.exclusion === null);
}

/** The rows of the `ms` before asOf: what the panel loads for its 7, 30, and 90-day windows. */
export function lastRows({ hourly, daily, asOf }: ResearchRows, ms = RESEARCH_WINDOW_MS): ResearchRows {
  return { hourly: rowsSince(hourly, asOf - ms), daily: rowsSince(daily, asOf - ms), asOf };
}

/** Rows for the longer windows: from where they start (the market's open, or LONG_HISTORY_MS before the end). */
export interface LongRows {
  hourly: ResearchRow[];
  daily: ResearchRow[];
  /** Where the longer windows start (ms). */
  start: number;
}

/** The stock's points over the longer windows: every 30-minute bar, and the daily bars since `longStart`. */
const longStock = ({ research, fetchedAt }: StockSide) =>
  researchStockPoints({ halfHourly: research.halfHourly, daily: research.longDaily, end: research.end, fetchedAt: settledAt(research, fetchedAt) });

/** Nothing before the start is the market's, so the rows begin there. */
const from = (rows: ResearchRow[], start: number) => rows.filter((r) => r.t >= start);

/** One market's rows for its longer windows. */
export function marketLongRows({ history, closeTime, ...side }: StockSide & { history: LongHistory; closeTime: number | null }): LongRows {
  const stock = longStock(side);
  const kalshi = history.points;
  return {
    hourly: from(buildResearchRows({ kalshi, closeTime, stock: stock.hourly, resolution: "hourly" }), history.start),
    daily: from(buildResearchRows({ kalshi, closeTime, stock: stock.daily, resolution: "daily" }), history.start),
    start: history.start,
  };
}

/** An event's rows for its longer windows, each reading E at its own mark. */
export function eventLongRows({ marks, start, ...side }: StockSide & { marks: ExpectedPoint[]; start: number }): LongRows {
  const stock = longStock(side);
  return {
    hourly: from(buildExpectedRows({ stock: stock.hourly, marks, resolution: "hourly" }), start),
    daily: from(buildExpectedRows({ stock: stock.daily, marks, resolution: "daily" }), start),
    start,
  };
}
