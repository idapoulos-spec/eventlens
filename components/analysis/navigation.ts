// URLs of an analysis (a stock compared with a Kalshi market) and what submitting one does.

export interface Analysis {
  stock: string;
  kalshi: string;
}

/** The home page URL that loads an analysis; tickers must already be validated. */
export function analysisHref({ stock, kalshi }: Analysis): string {
  return `/?${new URLSearchParams({ stock, kalshi })}`;
}

export function sameAnalysis(a: Analysis, b: Analysis): boolean {
  return a.stock === b.stock && a.kalshi === b.kalshi;
}

/**
 * Asking again for the analysis already on screen within this long only brings the
 * results into view. Reloading would spend shared Twelve Data credits on data that
 * has barely changed (price history is cached for 60 seconds anyway), and people
 * often submit twice while the first results are still loading.
 */
export const REANALYZE_AFTER_MS = 60_000;

/**
 * - `navigate`: load a different analysis.
 * - `refresh`: reload the analysis in the URL, e.g. after its results went stale or it was rate limited.
 * - `reveal`: the same results are already on screen and fresh; just show them.
 */
export type SubmitAction = "navigate" | "refresh" | "reveal";

/**
 * @param current the analysis in the URL, if it's valid
 * @param shownAt when `current`'s results were put on screen (ms); null if they aren't showing
 */
export function submitAction(next: Analysis, current: Analysis | null, shownAt: number | null, now: number): SubmitAction {
  if (current === null || !sameAnalysis(next, current)) return "navigate";
  if (shownAt !== null && now - shownAt < REANALYZE_AFTER_MS) return "reveal";
  return "refresh";
}
