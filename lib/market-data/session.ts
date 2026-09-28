// US equities trade 09:30–16:00 New York time. Twelve Data's hourly bars start at
// :30, so the last bar of each session (15:30) is only 30 minutes long.
const US_EXCHANGE_TIMEZONE = "America/New_York";
const US_SESSION_CLOSE = { hour: 16, minute: 0 };

/** Offset of `timeZone` from UTC at instant `t` (local minus UTC), in milliseconds. */
function timeZoneOffsetMs(t: number, timeZone: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "numeric",
    day: "numeric",
    hour: "numeric",
    minute: "numeric",
    second: "numeric",
  }).formatToParts(t);
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
