/** Below this many pairs, no correlation is reported at all. */
export const MIN_PAIRS = 10;
/** Below this many pairs, a correlation is shown but flagged as a small sample. */
export const SMALL_SAMPLE = 30;
/** Below this many non-zero Kalshi changes, a few moves decide the result. */
export const MIN_KALSHI_MOVES = 10;
/** Below this many events, an event-study average is flagged as based on too few events. */
export const SMALL_EVENT_COUNT = 10;

/**
 * How much a result based on `n` observations can be trusted:
 * "insufficient" (too few to report), "small" (report, with a warning), or "ok".
 */
export type SampleFlag = "insufficient" | "small" | "ok";

export function sampleFlag(n: number, min = MIN_PAIRS, small = SMALL_SAMPLE): SampleFlag {
  return n < min ? "insufficient" : n < small ? "small" : "ok";
}
