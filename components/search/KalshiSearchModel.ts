// State, fetching, and formatting for KalshiSearch, kept free of React so they can be tested directly.

import { DISPLAY_TIME_ZONE, formatDateTime } from "@/lib/format";
import { SEARCH_QUERY_PARAM, validateSearchQuery } from "@/lib/search/api";
import type { KalshiSearchResponse, KalshiSearchResult, SearchErrorResponse } from "@/lib/search/types";

/** Wait this long after the last keystroke before searching. */
export const DEBOUNCE_MS = 250;
/** Shorter queries match too much to be useful. */
export const MIN_QUERY_CHARS = 2;
/** A search still loading after this long explains that the first one can be slow. */
export const SLOW_SEARCH_MS = 2500;

/** The query to search for as the user types, or null if the text is too short to search. */
export function searchableQuery(text: string): string | null {
  const query = validateSearchQuery(text);
  return query.ok && Array.from(query.value).length >= MIN_QUERY_CHARS ? query.value : null;
}

// ---- State ----

export interface SearchState {
  /** What the popup is for; null when the text is too short to search. */
  query: string | null;
  status: "idle" | "loading" | "done" | "error";
  /** Results for `query` once loaded. While loading, the previous query's results stay up. */
  results: KalshiSearchResult[];
  open: boolean;
  /** Index of the highlighted result, or -1. */
  active: number;
  error: string | null;
  /** Whether the current search has been loading for SLOW_SEARCH_MS. */
  slow: boolean;
  /** Bumped by "retry", so the same query is fetched again. */
  attempt: number;
}

export type SearchAction =
  /** The user edited the text; `cached` holds results already loaded for this query. */
  | { type: "input"; query: string | null; cached?: KalshiSearchResult[] }
  | { type: "loaded"; query: string; results: KalshiSearchResult[] }
  | { type: "failed"; query: string; message: string }
  | { type: "slow"; query: string }
  | { type: "retry" }
  | { type: "move"; by: 1 | -1 }
  | { type: "highlight"; index: number }
  | { type: "open" }
  | { type: "close" }
  /** A result was picked: forget the query until the user types again. */
  | { type: "reset" };

export const initialSearchState: SearchState = {
  query: null,
  status: "idle",
  results: [],
  open: false,
  active: -1,
  error: null,
  slow: false,
  attempt: 0,
};

export function searchReducer(state: SearchState, action: SearchAction): SearchState {
  switch (action.type) {
    case "input":
      if (action.query === null) return { ...initialSearchState, attempt: state.attempt };
      // Edits that don't change the query (e.g. a trailing space) keep the list as it is.
      if (action.query === state.query && state.status !== "error") return { ...state, open: true };
      return {
        ...state,
        query: action.query,
        status: action.cached ? "done" : "loading",
        results: action.cached ?? state.results,
        open: true,
        active: -1,
        error: null,
        slow: false,
      };
    case "loaded":
      // A response for an older query arrived late: ignore it.
      if (action.query !== state.query) return state;
      return { ...state, status: "done", results: action.results, active: -1, error: null, slow: false };
    case "failed":
      if (action.query !== state.query) return state;
      return { ...state, status: "error", results: [], active: -1, error: action.message, slow: false };
    case "slow":
      return action.query === state.query && state.status === "loading" ? { ...state, slow: true } : state;
    case "retry":
      if (state.query === null || state.status !== "error") return state;
      return { ...state, status: "loading", error: null, open: true, attempt: state.attempt + 1 };
    case "move": {
      if (state.query === null) return state;
      const count = state.results.length;
      if (!state.open) return { ...state, open: true, active: count ? (action.by > 0 ? 0 : count - 1) : -1 };
      if (!count) return state;
      // Wraps around; from no highlight, down goes to the first result and up to the last.
      const from = state.active === -1 ? (action.by > 0 ? -1 : count) : state.active;
      return { ...state, active: (from + action.by + count) % count };
    }
    case "highlight":
      return action.index >= 0 && action.index < state.results.length ? { ...state, active: action.index } : state;
    case "open":
      return state.query === null || state.open ? state : { ...state, open: true };
    case "close":
      return state.open ? { ...state, open: false, active: -1 } : state;
    case "reset":
      return { ...initialSearchState, attempt: state.attempt };
  }
}

// ---- Fetching ----

export type SearchOutcome =
  | { ok: true; query: string; results: KalshiSearchResult[] }
  | { ok: false; message: string };

function fallbackMessage(status: number): string {
  if (status === 429) return "Too many searches. Please wait a moment and try again.";
  return "Search isn't working right now. You can still type a market ticker.";
}

/** Searches through the API route. Rejects only when `signal` aborts it. */
export async function fetchKalshiSearch(query: string, signal?: AbortSignal): Promise<SearchOutcome> {
  let res: Response;
  try {
    res = await fetch(`/api/search/kalshi?${new URLSearchParams({ [SEARCH_QUERY_PARAM]: query })}`, {
      headers: { Accept: "application/json" },
      signal,
    });
  } catch (err) {
    if (signal?.aborted) throw err;
    return { ok: false, message: "Couldn't reach the server. Check your connection and try again." };
  }
  const body: unknown = await res.json().catch(() => null);
  if (signal?.aborted) throw signal.reason;

  if (res.ok) {
    const data = body as Partial<KalshiSearchResponse> | null;
    if (Array.isArray(data?.results)) return { ok: true, query: data.query ?? query, results: data.results };
  }
  const message = (body as Partial<SearchErrorResponse> | null)?.error?.message;
  return { ok: false, message: typeof message === "string" && message ? message : fallbackMessage(res.status) };
}

/**
 * Recently loaded results by query, ignoring case like the search itself, so going back to
 * an earlier query (e.g. with backspace) shows its results without another request.
 */
export class ResultCache {
  private entries = new Map<string, { results: KalshiSearchResult[]; at: number }>();

  constructor(
    private maxEntries = 50,
    private ttlMs = 60_000,
  ) {}

  get(query: string, now = Date.now()): KalshiSearchResult[] | undefined {
    const key = query.toLowerCase();
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    if (now - entry.at >= this.ttlMs) {
      this.entries.delete(key);
      return undefined;
    }
    return entry.results;
  }

  set(query: string, results: KalshiSearchResult[], now = Date.now()) {
    const key = query.toLowerCase();
    this.entries.delete(key); // Re-insert so Map order tracks recency for eviction.
    this.entries.set(key, { results, at: now });
    if (this.entries.size > this.maxEntries) this.entries.delete(this.entries.keys().next().value!);
  }
}

/** Results the Kalshi field loaded recently; TickerForm reads them too (see isKalshiSearchText). */
export const kalshiResults = new ResultCache();

/**
 * Whether `text`, submitted without picking a result, is a search rather than a market
 * ticker: the field found markets for it, none with it as its ticker, and it has no "-"
 * (market tickers start with their event's ticker and a "-"). A single word such as
 * "recession" passes validateKalshiTicker, but analyzing it would only fail. Sends no request.
 */
export function isKalshiSearchText(text: string, results: ResultCache = kalshiResults): boolean {
  const query = searchableQuery(text);
  if (query === null || query.includes("-")) return false;
  const found = results.get(query);
  return !!found?.length && !found.some((r) => r.ticker === query.toUpperCase());
}

// ---- Formatting ----

/** Whole percents like Kalshi, but never a rounded "0%" or "100%" for an open market. */
export function formatChance(probability: number | null): string {
  if (probability === null) return "—";
  const pct = probability * 100;
  if (pct > 0 && pct < 1) return "<1%";
  if (pct > 99 && pct < 100) return ">99%";
  return `${Math.round(pct)}%`;
}

const DAY_MS = 24 * 60 * 60 * 1000;

const yearOf = (ms: number) =>
  new Intl.DateTimeFormat("en-US", { timeZone: DISPLAY_TIME_ZONE, year: "numeric" }).format(ms);

/**
 * When trading closes, in New York time like the dashboard: with the time if that's within
 * a day (e.g. "Closes Sep 29, 5:00 PM EDT"), else the date, e.g. "Closes Oct 29" or "Closes Jan 1, 2045".
 */
export function formatCloses(closeTime: string | null, now = Date.now()): string | null {
  const ms = closeTime ? Date.parse(closeTime) : NaN;
  if (!Number.isFinite(ms)) return null;
  if (ms - now < DAY_MS) return `Closes ${formatDateTime(ms)}`;
  const date = new Intl.DateTimeFormat("en-US", {
    timeZone: DISPLAY_TIME_ZONE,
    year: yearOf(ms) === yearOf(now) ? undefined : "numeric",
    month: "short",
    day: "numeric",
  }).format(ms);
  return `Closes ${date}`;
}
