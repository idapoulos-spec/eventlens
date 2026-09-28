/** A single observation in a time series. `t` is a Unix timestamp in milliseconds. */
export interface TimePoint {
  t: number;
  value: number;
}

export type ProbabilitySource = "midpoint" | "last_price" | "unavailable";

export interface ProbabilityChange {
  /** Change in percentage points, or null if history does not reach back far enough. */
  pp: number | null;
  /** Timestamp (ms) of the historical point the current probability was compared against. */
  from: number | null;
}

export interface ProbabilityEstimate {
  /** Probability in the range [0, 1], or null when it cannot be estimated. */
  value: number | null;
  source: ProbabilitySource;
}
