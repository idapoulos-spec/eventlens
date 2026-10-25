// URLs of an analysis (a stock compared with a Kalshi market) and what submitting one does.

import {
  ASOF_PARAM,
  BENCHMARK_PARAM,
  formatAsOf,
  JUMP_PARAM,
  parseResearchLink,
  RESOLUTION_PARAM,
  RETURNS_PARAM,
  WINDOW_PARAM,
  type ResearchView,
} from "@/lib/history/window";
import { validateKalshiTicker, validateStockTicker } from "@/lib/validation";

export interface Analysis {
  stock: string;
  kalshi: string;
}

/**
 * The home page URL that loads an analysis; tickers must already be validated. With `view`,
 * Research opens with those settings (each left out at its default), frozen at its as-of time if given.
 */
export function analysisHref({ stock, kalshi }: Analysis, view?: Partial<ResearchView>): string {
  const params = new URLSearchParams({ stock, kalshi });
  if (view?.window != null) params.set(WINDOW_PARAM, String(view.window));
  if (view?.resolution != null) params.set(RESOLUTION_PARAM, view.resolution);
  if (view?.returns != null) params.set(RETURNS_PARAM, view.returns);
  if (view?.benchmark != null) params.set(BENCHMARK_PARAM, view.benchmark);
  if (view?.jump != null) params.set(JUMP_PARAM, String(view.jump));
  if (view?.asOf != null) params.set(ASOF_PARAM, formatAsOf(view.asOf));
  return `/?${params}`;
}

/**
 * The analysis link in a page's query string (`search`, e.g. location.search), rebuilt from what
 * the page reads, so anything else in it is dropped; null if it doesn't name a valid analysis.
 */
export function currentAnalysisHref(search: string, now: number): string | null {
  const analysis = analysisFromSearch(search);
  const params = new URLSearchParams(search);
  const { view, asOf } = parseResearchLink((name) => params.get(name), now);
  return analysis && asOf.ok ? analysisHref(analysis, view) : null;
}

/** The analysis a page's query string names, if both tickers are valid. */
export function analysisFromSearch(search: string): Analysis | null {
  const params = new URLSearchParams(search);
  const stock = validateStockTicker(params.get("stock"));
  const kalshi = validateKalshiTicker(params.get("kalshi"));
  return stock.ok && kalshi.ok ? { stock: stock.value, kalshi: kalshi.value } : null;
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
