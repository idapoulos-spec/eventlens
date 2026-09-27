/** A single observation in a time series. `t` is a Unix timestamp in milliseconds. */
export interface TimePoint {
  t: number;
  value: number;
}

export type ProbabilitySource = "midpoint" | "last_price" | "unavailable";

export interface ProbabilityEstimate {
  /** Probability in the range [0, 1], or null when it cannot be estimated. */
  value: number | null;
  source: ProbabilitySource;
}
