import { DISPLAY_TIME_ZONE } from "@/lib/format";
// Imported directly: the lib/market-data index also loads the server-only Twelve Data client.
import { timeZoneOffsetMs } from "@/lib/market-data/session";

// Chart axes use the same New York time zone as the tooltips (see formatDateTime), so a
// tick labeled "Sep 25" sits at midnight New York time whatever time zone the viewer is in.

const DAY_MS = 24 * 60 * 60 * 1000;

const axisDate = new Intl.DateTimeFormat("en-US", { timeZone: DISPLAY_TIME_ZONE, month: "short", day: "numeric" });
const axisHour = new Intl.DateTimeFormat("en-US", { timeZone: DISPLAY_TIME_ZONE, hour: "numeric" });
const tradingDate = new Intl.DateTimeFormat("en-US", {
  timeZone: DISPLAY_TIME_ZONE,
  weekday: "short",
  month: "short",
  day: "numeric",
  year: "numeric",
});

/** Offset of New York time from UTC at instant `t` (local minus UTC), in milliseconds. */
const offsetMs = (t: number) => timeZoneOffsetMs(t, DISPLAY_TIME_ZONE);

const isNewYorkMidnight = (t: number) => (t + offsetMs(t)) % DAY_MS === 0;

/** UTC timestamp of a New York wall-clock time on `date` (read from its UTC fields). */
function newYorkTime(date: Date, hour = 0, minute = 0): number {
  const asUtc = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate(), hour, minute);
  // A second pass corrects the offset if a DST switch falls between the guess and the answer.
  return asUtc - offsetMs(asUtc - offsetMs(asUtc));
}

/** New York calendar date containing instant `t`, as a UTC-midnight Date for date arithmetic. */
function newYorkDate(t: number): Date {
  const local = new Date(t + offsetMs(t));
  return new Date(Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate()));
}

/**
 * Daily bars are stamped at 00:00 UTC of the trading date, which is the previous evening
 * in New York. Re-stamp one at the 4:00 PM New York close of its trading date, so it
 * reads as the right day on New York-time axes and tooltips.
 */
export function tradingDayClose(utcMidnight: number): number {
  return newYorkTime(new Date(utcMidnight), 16, 0);
}

/** Axis label: the date at New York midnight (e.g. "Sep 25"), otherwise the hour (e.g. "6 PM"). */
export function formatAxisTick(t: number): string {
  return isNewYorkMidnight(t) ? axisDate.format(t) : axisHour.format(t);
}

/** Tooltip heading for a daily bar, e.g. "Fri, Sep 25, 2026". */
export function formatTradingDate(t: number): string {
  return tradingDate.format(t);
}

/**
 * X-axis ticks in New York time within a chronologically sorted series: every 6 hours
 * for spans up to two days, then midnights — every day up to three weeks, Mondays up to
 * about six months, then the first of each month. Thinned to at most `maxTicks` without
 * dropping every midnight, so a span that contains a midnight always shows a date.
 */
export function timeTicks(points: { t: number }[], maxTicks = 8): number[] | undefined {
  if (points.length < 2) return undefined;
  const min = points[0].t;
  const max = points[points.length - 1].t;
  const span = max - min;
  const hours = span <= 2 * DAY_MS ? [0, 6, 12, 18] : [0];
  const keep = (d: Date) => (span <= 21 * DAY_MS ? true : span <= 190 * DAY_MS ? d.getUTCDay() === 1 : d.getUTCDate() === 1);

  const ticks: number[] = [];
  const day = newYorkDate(min);
  while (newYorkTime(day) <= max) {
    if (keep(day)) {
      for (const hour of hours) {
        const t = newYorkTime(day, hour);
        if (t >= min && t <= max) ticks.push(t);
      }
    }
    day.setUTCDate(day.getUTCDate() + 1);
  }
  if (ticks.length === 0) return undefined;
  const step = Math.ceil(ticks.length / maxTicks);
  // Count the kept ticks from the first midnight, not the first tick: with 6-hour ticks
  // starting at 6 AM, every other tick from the start would skip all the midnights.
  const offset = Math.max(0, ticks.findIndex(isNewYorkMidnight)) % step;
  return ticks.filter((_, i) => i % step === offset);
}
