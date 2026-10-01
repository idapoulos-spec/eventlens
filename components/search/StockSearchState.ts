// State of the stock field's suggestion list. A reducer, so keyboard navigation and
// out-of-order responses can be tested without a browser.

import type { StockSearchResult } from "@/lib/search/types";

/** Search this long after the last keystroke, so typing a name sends one request, not one per letter. */
export const SEARCH_DEBOUNCE_MS = 250;

/** After this long without results, the popup explains why the search is slow. */
export const SLOW_SEARCH_MS = 3000;

export interface StockSearchState {
  /** What the user typed, normalized with validateSearchQuery; "" when there's nothing to search for. */
  query: string;
  /** Whether the popup (results, or a message) is showing. */
  open: boolean;
  /** "loading" until results for `query` arrive; meanwhile `results` still holds the previous query's. */
  status: "idle" | "loading" | "done" | "error";
  /** Loading has taken longer than SLOW_SEARCH_MS, as the first search on a server each day does. */
  slow: boolean;
  results: StockSearchResult[];
  error: string | null;
  /** Highlighted result, or -1. Only results for the current query are highlighted. */
  active: number;
}

export type StockSearchAction =
  /** The user edited the field. `cached` holds results already fetched for this query. */
  | { type: "edit"; query: string; cached?: StockSearchResult[] }
  | { type: "loaded"; query: string; results: StockSearchResult[] }
  | { type: "failed"; query: string; message: string }
  | { type: "slow"; query: string }
  | { type: "move"; by: 1 | -1 }
  | { type: "hover"; index: number }
  | { type: "open" }
  | { type: "close" }
  /** A result was picked: start over. */
  | { type: "reset" };

export const initialStockSearchState: StockSearchState = {
  query: "",
  open: false,
  status: "idle",
  slow: false,
  results: [],
  error: null,
  active: -1,
};

/** Fresh results highlight the best match, so Enter picks it. */
function withResults(state: StockSearchState, results: StockSearchResult[]): StockSearchState {
  return { ...state, status: "done", slow: false, results, error: null, active: results.length > 0 ? 0 : -1 };
}

export function stockSearchReducer(state: StockSearchState, action: StockSearchAction): StockSearchState {
  switch (action.type) {
    case "edit":
      if (!action.query) return initialStockSearchState;
      if (action.query === state.query) return { ...state, open: true };
      if (action.cached) return withResults({ ...state, query: action.query, open: true }, action.cached);
      return { ...state, query: action.query, open: true, status: "loading", slow: false, error: null, active: -1 };
    case "loaded":
      // A response for an earlier query is out of date.
      return action.query === state.query ? withResults(state, action.results) : state;
    case "failed":
      return action.query === state.query
        ? { ...state, status: "error", slow: false, results: [], error: action.message, active: -1 }
        : state;
    case "slow":
      return action.query === state.query && state.status === "loading" ? { ...state, slow: true } : state;
    case "move": {
      const count = state.results.length;
      if (!state.open || state.status !== "done" || count === 0) return state;
      if (state.active < 0) return { ...state, active: action.by > 0 ? 0 : count - 1 };
      return { ...state, active: (state.active + action.by + count) % count };
    }
    case "hover":
      return state.status === "done" && action.index >= 0 && action.index < state.results.length
        ? { ...state, active: action.index }
        : state;
    case "open":
      return state.query && !state.open ? { ...state, open: true } : state;
    case "close":
      return state.open ? { ...state, open: false } : state;
    case "reset":
      return initialStockSearchState;
  }
}

/** The result Enter picks: the highlighted one, if the popup is showing results for what's typed. */
export function highlightedResult(state: StockSearchState): StockSearchResult | null {
  return state.open && state.status === "done" ? (state.results[state.active] ?? null) : null;
}

/** What a screen reader hears when the popup's content changes. */
export function searchAnnouncement(state: StockSearchState): string {
  if (!state.open) return "";
  if (state.status === "error") return state.error ?? "";
  if (state.status === "loading") return state.slow ? SLOW_SEARCH_MESSAGE : "";
  const count = state.results.length;
  if (count === 0) return noMatchesMessage(state.query);
  return `${count} ${count === 1 ? "result" : "results"}. Use the up and down arrow keys to choose, and Enter to pick.`;
}

export const noMatchesMessage = (query: string) => `No US stocks or ETFs match “${query}”.`;

export const SLOW_SEARCH_MESSAGE =
  "Still searching. The first search in a while loads the list of US stocks, which can take up to a minute.";
