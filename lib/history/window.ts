// Where Research's window ends, and what it reads in it. Pure, so the browser can use it too
// (the benchmark picker sends the window's end to /api/benchmark).

import { topOfHourCloses } from "@/lib/analytics/research";
import type { TimePoint } from "@/lib/analytics/types";
import { DISPLAY_TIME_ZONE, formatDateTime } from "@/lib/format";
import { sessionClosePoints, timeZoneOffsetMs } from "@/lib/market-data/session";
import type { StockBar } from "@/lib/market-data/types";
import { fail, ok, type Result } from "@/lib/result";
import { validateStockTicker } from "@/lib/validation";
import type { LongRows } from "./rows";
import type { FoundMarket, Provenance, ResearchBars, ResearchWindow } from "./types";

const DAY_MS = 24 * 60 * 60 * 1000;

/** The rows the page loads with (the 7, 30, and 90-day windows). */
export const RESEARCH_WINDOW_MS = 90 * DAY_MS;
/** Kalshi history reaches a week further back, to find the probability in effect when the window starts. */
export const KALSHI_HISTORY_MS = RESEARCH_WINDOW_MS + 7 * DAY_MS;
/** Stock bars for a window that ends in the past: the 90 days, plus a margin for the session before it. */
export const STOCK_HISTORY_MS = 100 * DAY_MS;
/**
 * The longest history Research's longer windows (180 days, a year, and "All") can read: 540
 * days of 30-minute bars is about 372 sessions of 13 bars, under the 5,000 one Twelve Data
 * request returns for one credit (4,828 for SPY from 2025-04-22 to 2026-10-14).
 */
export const LONG_HISTORY_DAYS = 540;
export const LONG_HISTORY_MS = LONG_HISTORY_DAYS * DAY_MS;

/** Research ending now, as without the store. */
export const LIVE_WINDOW: ResearchWindow = { end: null, archived: false, start: null };

const timeOf = (iso: string | null) => {
  const ms = iso === null ? NaN : Date.parse(iso);
  return Number.isFinite(ms) ? ms : null;
};

/**
 * Research ends at the market's close once that has passed, otherwise now; its longer windows
 * start no earlier than its open. With `asOf` (a link's as-of time), the window ends there
 * instead of now, and at the close only if the market had closed by then.
 */
export function windowFor({ market, archived }: FoundMarket, now: number, asOf: number | null = null): ResearchWindow {
  return closedOr(timeOf(market.closeTime), { archived, start: timeOf(market.openTime) }, now, asOf);
}

/** A window ending at `close` if it had passed by the as-of time (or now), else at the as-of time (or now). */
export function closedOr(close: number | null, rest: Pick<ResearchWindow, "archived" | "start">, now: number, asOf: number | null): ResearchWindow {
  if (close !== null && close <= (asOf ?? now)) return { end: close, ...rest };
  return asOf === null ? { end: null, ...rest } : { end: asOf, ...rest, frozen: true };
}

/**
 * When the bars count as settled: when they were fetched, or for a window frozen at an as-of
 * time, then (bars that settled only after it weren't on screen at the time).
 */
export function settledAt({ end, frozen = false }: Pick<ResearchBars, "end" | "frozen">, fetchedAt: number): number {
  return frozen && end !== null ? Math.min(fetchedAt, end) : fetchedAt;
}

/**
 * Where the longer windows start for a window ending at `anchor` (ms): the market's open, but no
 * more than LONG_HISTORY_MS before the end.
 */
export function longHistoryStart(start: number | null, anchor: number): number {
  return Math.max(start ?? -Infinity, anchor - LONG_HISTORY_MS);
}

/** Where a stock's bars start: far enough back for the longer windows, and never less than STOCK_HISTORY_MS. */
export function stockHistoryStart(start: number | null, anchor: number): number {
  return Math.min(longHistoryStart(start, anchor), anchor - STOCK_HISTORY_MS);
}

/**
 * The stock observations Research lines Kalshi up with: top-of-hour closes of settled bars, and
 * each session's close (see sessionClosePoints). A window ending in the past keeps what came
 * up to its end, including a bar that closed at that very moment.
 */
export function researchStockPoints({
  halfHourly,
  daily,
  fetchedAt,
  end,
}: {
  halfHourly: StockBar[];
  daily: StockBar[];
  /** When the bars were fetched: bars that hadn't settled by then are left out. */
  fetchedAt: number;
  end: number | null;
}): { hourly: TimePoint[]; daily: TimePoint[] } {
  const hourly = topOfHourCloses(
    halfHourly.map((b) => ({ t: b.t, value: b.close })),
    fetchedAt,
  );
  // Each session's real close, so early-close days line up with Kalshi at the right moment.
  const closes = sessionClosePoints(daily, halfHourly);
  if (end === null) return { hourly, daily: closes };
  return { hourly: hourly.filter((p) => p.t <= end), daily: closes.filter((p) => p.t <= end) };
}

// ---- Research's windows: which rows each one reads (the panel and the scan share this) ----

export const WINDOWS = [7, 30, 90, 180, 365, "all"] as const;
export type WindowChoice = (typeof WINDOWS)[number];
export const WINDOW_LABEL: Record<WindowChoice, string> = { 7: "7D", 30: "30D", 90: "90D", 180: "180D", 365: "1Y", all: "All" };
/** Windows past the 90 days the page loads with: their rows stream in after it, and they're computed in the background. */
export const isLongWindow = (w: WindowChoice) => w === "all" || w > 90;

/**
 * Where Research opens, from a link: every setting that changes its results. Null (or absent)
 * for each default: 90D, hourly, market-adjusted, SPY, the resolution's default jump size, and
 * windows ending now.
 */
export interface ResearchView {
  window: WindowChoice | null;
  resolution: "hourly" | "daily" | null;
  /** Raw returns; null for market-adjusted. */
  returns?: "raw" | null;
  /** The benchmark, when it isn't the default. */
  benchmark?: string | null;
  /** The event study's jump size at the resolution shown, in the variable's unit, when it isn't the default. */
  jump?: number | null;
  /** A frozen link's as-of time (ms): Research ends there (see windowFor). */
  asOf?: number | null;
}

export const WINDOW_PARAM = "window";
export const RESOLUTION_PARAM = "res";
export const RETURNS_PARAM = "returns";
export const BENCHMARK_PARAM = "bench";
export const JUMP_PARAM = "jump";

/** A link's `window` (7, 30, 90, 180, 365, or all) and `res` (hourly or daily); anything else is the default. */
export function parseResearchView(window: string | null | undefined, resolution: string | null | undefined): ResearchView {
  const choice = WINDOWS.find((w) => String(w) === window) ?? null;
  return { window: choice, resolution: resolution === "hourly" || resolution === "daily" ? resolution : null };
}

const JUMP_FORMAT = /^\d{1,3}(\.\d{1,2})?$/;

/**
 * Every Research setting a link carries. A setting that isn't valid falls back to its default
 * (the panel checks the jump size against the variable's sizes), except the as-of time: a link
 * that names one it can't read is an error, so it never quietly shows live numbers instead.
 */
export function parseResearchLink(get: (name: string) => string | null | undefined, now: number): { view: ResearchView; asOf: Result<number | null> } {
  const view = parseResearchView(get(WINDOW_PARAM), get(RESOLUTION_PARAM));
  const bench = get(BENCHMARK_PARAM);
  const benchmark = bench ? validateStockTicker(bench) : null;
  const jump = get(JUMP_PARAM);
  const asOf = parseAsOf(get(ASOF_PARAM), now);
  return {
    view: {
      ...view,
      returns: get(RETURNS_PARAM) === "raw" ? "raw" : null,
      benchmark: benchmark?.ok ? benchmark.value : null,
      jump: jump && JUMP_FORMAT.test(jump) && Number(jump) > 0 ? Number(jump) : null,
      asOf: asOf.ok ? asOf.data : null,
    },
    asOf,
  };
}

/** How a window is computed: from the rows the page loaded with, in the background from the longer rows, or not yet. */
export type WindowPlan =
  | { kind: "loaded"; days: number; /** A longer window that's no longer than 90 days for this market. */ sameAs90: boolean }
  | { kind: "long"; rows: LongRows; from: number }
  | { kind: "waiting" }
  | { kind: "failed"; message: string };

export function windowPlan(choice: WindowChoice, long: Result<LongRows | null> | null, asOf: number): WindowPlan {
  if (!isLongWindow(choice)) return { kind: "loaded", days: choice as number, sameAs90: false };
  if (long === null) return { kind: "waiting" };
  if (!long.ok) return { kind: "failed", message: long.error.message };
  if (long.data === null) return { kind: "loaded", days: 90, sameAs90: true };
  const from = choice === "all" ? -Infinity : asOf - choice * DAY_MS;
  if (Math.max(from, long.data.start) >= asOf - RESEARCH_WINDOW_MS) return { kind: "loaded", days: 90, sameAs90: true };
  return { kind: "long", rows: long.data, from };
}

// ---- /api/benchmark?symbol=QQQ&end=… : a benchmark for a window that ends in the past ----

export const BENCHMARK_END_PARAM = "end";
/** With `end`: the window is frozen at that as-of time (see ResearchWindow.frozen), so only bars settled by then count. */
export const BENCHMARK_FROZEN_PARAM = "frozen";
const EARLIEST_END = Date.UTC(2015, 0, 1);

/** A window's end from a URL: absent (null), or whole milliseconds since 2015, not in the future. */
export function parseWindowEnd(value: string | null, now: number): Result<number | null> {
  if (value === null) return ok(null);
  const end = /^\d{1,15}$/.test(value) ? Number(value) : NaN;
  if (!(end >= EARLIEST_END && end <= now)) {
    return fail("invalid_end", "The research window's end must be a past time, in milliseconds.");
  }
  return ok(end);
}

// ---- ?asof=… : where a frozen link's Research ends ----

/** An analysis link's as-of time: Research ends there, so the link gives the same numbers later. */
export const ASOF_PARAM = "asof";
const ASOF_FORMAT = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?Z$/;

/**
 * An as-of time from a link: absent (null), or UTC ISO 8601 to the minute, second, or
 * millisecond (2026-10-25T18:05Z, …T18:05:12Z, …T18:05:12.345Z), from 2015 up to now.
 */
export function parseAsOf(value: string | null | undefined, now: number): Result<number | null> {
  if (value === null || value === undefined) return ok(null);
  const m = ASOF_FORMAT.exec(value);
  const ms = m ? Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +(m[6] ?? 0), +(m[7] ?? "0").padEnd(3, "0")) : NaN;
  // Date.UTC rolls 2026-02-31 over to March; a real date and time reads back the same.
  const exact = m !== null && Number.isFinite(ms) && new Date(ms).toISOString().slice(0, 16) === `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}`;
  if (!exact) return fail("invalid_asof", "The link's as-of time isn't a valid UTC time, such as 2026-10-25T18:05Z.");
  if (ms < EARLIEST_END || ms > now) return fail("invalid_asof", "The link's as-of time must be in the past, and no earlier than 2015.");
  return ok(ms);
}

/** A time as a date-time field shows it in New York time ("2026-10-07T14:02"), to the minute. */
export function newYorkInput(ms: number): string {
  return new Date(ms + timeZoneOffsetMs(ms, DISPLAY_TIME_ZONE)).toISOString().slice(0, 16);
}

/** A date-time field's New York time ("2026-10-07T14:02") as ms, or null if it isn't one. */
export function fromNewYorkInput(text: string): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(text);
  if (!m) return null;
  const wall = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]);
  // The offset at the wall time read as UTC, then at the result: right on both sides of a DST change.
  let t = wall - timeZoneOffsetMs(wall, DISPLAY_TIME_ZONE);
  t = wall - timeZoneOffsetMs(t, DISPLAY_TIME_ZONE);
  return newYorkInput(t) === text ? t : null;
}

/** An as-of time for a link: to the minute when that's exact, else to the millisecond. */
export function formatAsOf(ms: number): string {
  const iso = new Date(ms).toISOString();
  if (iso.endsWith(":00.000Z")) return `${iso.slice(0, 16)}Z`;
  return iso.endsWith(".000Z") ? `${iso.slice(0, 19)}Z` : iso;
}

// ---- The Sources note ----

/** "Kalshi research history stored through …", or null if no stored candles were used. */
export function provenanceNote({ storedThrough, liveFrom, liveFailed }: Provenance): string | null {
  if (storedThrough === null) return null;
  const through = `Kalshi research history stored through ${formatDateTime(storedThrough, { withYear: true })}`;
  if (liveFailed) return `${through}; later candles couldn't be loaded.`;
  return liveFrom === null ? `${through}.` : `${through}, live after that.`;
}
