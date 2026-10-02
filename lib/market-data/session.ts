import type { StockBar } from "./types";

// US equities trade 09:30–16:00 New York time. Twelve Data's hourly bars start at
// :30, so the last bar of each session (15:30) is only 30 minutes long.
const US_EXCHANGE_TIMEZONE = "America/New_York";
const US_SESSION_CLOSE = { hour: 16, minute: 0 };

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
// Bars further apart than this belong to different sessions (overnight, weekends, holidays).
const SESSION_GAP_MS = 3 * HOUR_MS;

// Building an Intl.DateTimeFormat is slow, and chart axes need many offsets per render.
const wallClockFormats = new Map<string, Intl.DateTimeFormat>();

function wallClockFormat(timeZone: string): Intl.DateTimeFormat {
  let format = wallClockFormats.get(timeZone);
  if (!format) {
    format = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "numeric",
      day: "numeric",
      hour: "numeric",
      minute: "numeric",
      second: "numeric",
    });
    wallClockFormats.set(timeZone, format);
  }
  return format;
}

/** Offset of `timeZone` from UTC at instant `t` (local minus UTC), in milliseconds. */
export function timeZoneOffsetMs(t: number, timeZone: string): number {
  const parts = wallClockFormat(timeZone).formatToParts(t);
  const get = (type: Intl.DateTimeFormatPartTypes) => Number(parts.find((p) => p.type === type)?.value);
  const localAsUtc = Date.UTC(get("year"), get("month") - 1, get("day"), get("hour"), get("minute"), get("second"));
  return localAsUtc - (t - (t % 1000));
}

/** UTC timestamp of wall-clock `hour:minute` in `timeZone`, on the local date containing instant `t`. */
function wallClockOnSameDay(t: number, timeZone: string, hour: number, minute: number): number {
  const local = new Date(t + timeZoneOffsetMs(t, timeZone));
  const guess = Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate(), hour, minute);
  // Afternoon times are never near a DST switch, so one offset correction is exact.
  return guess - timeZoneOffsetMs(guess, timeZone);
}

/**
 * Close time of an intraday bar: its open plus the interval, capped at the regular
 * session close for US exchanges so the shortened final bar is stamped at 16:00.
 * Early-close days (e.g. 13:00 before holidays) are not modelled.
 */
export function barCloseTime(openMs: number, intervalMs: number, exchangeTimeZone?: string): number {
  const end = openMs + intervalMs;
  if (exchangeTimeZone !== US_EXCHANGE_TIMEZONE) return end;

  const sessionClose = wallClockOnSameDay(openMs, exchangeTimeZone, US_SESSION_CLOSE.hour, US_SESSION_CLOSE.minute);
  return sessionClose > openMs && sessionClose < end ? sessionClose : end;
}

/**
 * Daily bars are stamped at 00:00 UTC of the trading date, which is the previous evening
 * in New York. Re-stamp one at the 4:00 PM New York close of its trading date, so it
 * reads as the right day on New York-time axes and tooltips.
 */
export function tradingDayClose(utcMidnight: number): number {
  // Noon UTC is the same calendar date in New York.
  return wallClockOnSameDay(utcMidnight + 12 * HOUR_MS, US_EXCHANGE_TIMEZONE, US_SESSION_CLOSE.hour, US_SESSION_CLOSE.minute);
}

/**
 * When each session actually ended, keyed by its trading date at 00:00 UTC (how daily
 * bars are stamped): the close time of its last intraday bar, in New York time. Unlike
 * tradingDayClose, this catches early closes, such as 1:00 PM before a holiday.
 */
export function sessionCloseTimes(bars: StockBar[]): Map<number, number> {
  const closes = new Map<number, number>();
  for (const { t } of bars) {
    const local = t + timeZoneOffsetMs(t, US_EXCHANGE_TIMEZONE);
    const date = local - (((local % DAY_MS) + DAY_MS) % DAY_MS);
    closes.set(date, Math.max(closes.get(date) ?? t, t));
  }
  return closes;
}

/**
 * Daily closes stamped at the moment each session ended, from daily bars and the same
 * stock's 30-minute bars (see sessionCloseTimes); sessions the 30-minute bars don't cover
 * fall back to 4:00 PM New York. Stocks and benchmarks are stamped the same way, so their
 * daily closes line up on exactly the same timestamps.
 */
export function sessionClosePoints(daily: StockBar[], halfHourly: StockBar[]): { t: number; value: number }[] {
  const closes = sessionCloseTimes(halfHourly);
  return daily.map((b) => ({ t: closes.get(b.t) ?? tradingDayClose(b.t), value: b.close }));
}

/**
 * Combine close-stamped 30-minute bars into the hourly bars Twelve Data itself returns:
 * hours counted from each session's first bar (09:30–10:30, …, 14:30–15:30), with the
 * final half hour (15:30–16:00) as its own bar. Each hourly bar is stamped like
 * Twelve Data's (see barCloseTime), so the two are interchangeable.
 */
export function toHourlyBars(bars: StockBar[], intervalMs: number, exchangeTimeZone?: string): StockBar[] {
  const hourly: StockBar[] = [];
  let sessionOpen = -Infinity;
  let bucketOpen = -Infinity;
  let prevOpen = -Infinity;
  for (const bar of bars) {
    const open = bar.t - intervalMs;
    if (open - prevOpen > SESSION_GAP_MS) sessionOpen = open;
    prevOpen = open;
    const start = sessionOpen + Math.floor((open - sessionOpen) / HOUR_MS) * HOUR_MS;
    const last = hourly.at(-1);
    if (last && start === bucketOpen) {
      last.high = Math.max(last.high, bar.high);
      last.low = Math.min(last.low, bar.low);
      last.close = bar.close;
      last.volume = last.volume === null || bar.volume === null ? (last.volume ?? bar.volume) : last.volume + bar.volume;
    } else {
      bucketOpen = start;
      hourly.push({ ...bar, t: barCloseTime(start, HOUR_MS, exchangeTimeZone) });
    }
  }
  return hourly;
}
