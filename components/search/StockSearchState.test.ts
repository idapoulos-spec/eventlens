import { describe, expect, it } from "vitest";
import type { StockSearchResult } from "@/lib/search/types";
import {
  highlightedResult,
  initialStockSearchState,
  searchAnnouncement,
  SLOW_SEARCH_MESSAGE,
  stockSearchReducer,
  type StockSearchAction,
  type StockSearchState,
} from "./StockSearchState";

const result = (symbol: string, name = `${symbol} Inc.`): StockSearchResult => ({
  symbol,
  name,
  exchange: "NASDAQ",
  type: "Common Stock",
});
const NVDA = result("NVDA", "NVIDIA Corporation");
const NVDL = result("NVDL");
const NVDX = result("NVDX");

function run(...actions: StockSearchAction[]): StockSearchState {
  return actions.reduce(stockSearchReducer, initialStockSearchState);
}

const typed = (query: string): StockSearchAction => ({ type: "edit", query });
const loaded = (query: string, results: StockSearchResult[]): StockSearchAction => ({ type: "loaded", query, results });
const down: StockSearchAction = { type: "move", by: 1 };
const up: StockSearchAction = { type: "move", by: -1 };

describe("stockSearchReducer", () => {
  it("opens and starts loading when the user types, and highlights the best result when it arrives", () => {
    const loading = run(typed("nv"));
    expect(loading).toMatchObject({ query: "nv", open: true, status: "loading", active: -1 });
    expect(highlightedResult(loading)).toBeNull();

    const done = stockSearchReducer(loading, loaded("nv", [NVDA, NVDL]));
    expect(done).toMatchObject({ status: "done", results: [NVDA, NVDL], active: 0 });
    expect(highlightedResult(done)).toBe(NVDA);
  });

  it("shows results already fetched for a query at once", () => {
    const state = run(typed("nv"), loaded("nv", [NVDA]), typed("nvd"), { type: "edit", query: "nv", cached: [NVDA] });
    expect(state).toMatchObject({ query: "nv", status: "done", results: [NVDA], active: 0 });
  });

  it("ignores responses for an earlier query", () => {
    const state = run(typed("nv"), typed("nvidia"), loaded("nv", [NVDA, NVDL, NVDX]));
    expect(state).toMatchObject({ query: "nvidia", status: "loading" });
    expect(run(typed("nv"), typed("nvidia"), { type: "failed", query: "nv", message: "Boom" }).status).toBe("loading");
  });

  it("keeps the previous results while the next search loads, without highlighting them", () => {
    const state = run(typed("nv"), loaded("nv", [NVDA, NVDL]), typed("nvd"));
    expect(state).toMatchObject({ status: "loading", results: [NVDA, NVDL], active: -1 });
    // Their query is no longer what's typed, so Enter doesn't pick them and arrows don't move.
    expect(highlightedResult(state)).toBeNull();
    expect(stockSearchReducer(state, down)).toBe(state);
  });

  it("moves the highlight with the arrow keys, wrapping around", () => {
    const start = run(typed("nv"), loaded("nv", [NVDA, NVDL, NVDX]));
    expect(run(typed("nv"), loaded("nv", [NVDA, NVDL, NVDX]), down).active).toBe(1);
    expect([down, down, down].reduce(stockSearchReducer, start).active).toBe(0);
    expect(stockSearchReducer(start, up).active).toBe(2);
  });

  it("follows the pointer over results", () => {
    const start = run(typed("nv"), loaded("nv", [NVDA, NVDL]));
    expect(stockSearchReducer(start, { type: "hover", index: 1 }).active).toBe(1);
    expect(stockSearchReducer(start, { type: "hover", index: 5 })).toBe(start);
  });

  it("reports a failed search, clearing the results", () => {
    const state = run(typed("nv"), loaded("nv", [NVDA]), typed("nvidia"), {
      type: "failed",
      query: "nvidia",
      message: "Twelve Data rate limit reached.",
    });
    expect(state).toMatchObject({ status: "error", error: "Twelve Data rate limit reached.", results: [], active: -1 });
    expect(highlightedResult(state)).toBeNull();
  });

  it("closes on Escape or blur and reopens on arrow down, keeping the highlight", () => {
    const start = run(typed("nv"), loaded("nv", [NVDA, NVDL]), down);
    const closed = stockSearchReducer(start, { type: "close" });
    expect(closed.open).toBe(false);
    // Enter submits the form while the list is closed.
    expect(highlightedResult(closed)).toBeNull();
    // Arrow keys reopen the list before they move the highlight.
    expect(stockSearchReducer(closed, down)).toBe(closed);
    expect(stockSearchReducer(closed, { type: "open" })).toMatchObject({ open: true, active: 1 });
  });

  it("stays closed when there's nothing to search for", () => {
    const cleared = run(typed("nv"), loaded("nv", [NVDA]), typed(""));
    expect(cleared).toEqual(initialStockSearchState);
    expect(stockSearchReducer(cleared, { type: "open" })).toBe(cleared);
  });

  it("reopens without searching again when an edit doesn't change the query", () => {
    const state = run(typed("nv"), loaded("nv", [NVDA]), { type: "close" }, typed("nv"));
    expect(state).toMatchObject({ open: true, status: "done", results: [NVDA] });
  });

  it("starts over once a result is picked", () => {
    expect(run(typed("nv"), loaded("nv", [NVDA]), { type: "reset" })).toEqual(initialStockSearchState);
  });

  it("marks a search that takes a while as slow, until its results arrive", () => {
    const slow = run(typed("nv"), { type: "slow", query: "nv" });
    expect(slow.slow).toBe(true);
    expect(stockSearchReducer(slow, loaded("nv", [NVDA])).slow).toBe(false);
    // A newer query starts its own wait.
    expect(stockSearchReducer(slow, typed("nvd")).slow).toBe(false);
    expect(run(typed("nv"), typed("nvd"), { type: "slow", query: "nv" }).slow).toBe(false);
  });

  it("loads results that arrive after the list was closed, without reopening it", () => {
    const state = run(typed("nv"), { type: "close" }, loaded("nv", [NVDA]));
    expect(state).toMatchObject({ open: false, status: "done", results: [NVDA] });
  });
});

describe("searchAnnouncement", () => {
  it("announces how many results there are, no matches, and errors, but not every keystroke", () => {
    expect(searchAnnouncement(run(typed("nv")))).toBe("");
    expect(searchAnnouncement(run(typed("nv"), { type: "slow", query: "nv" }))).toBe(SLOW_SEARCH_MESSAGE);
    expect(searchAnnouncement(run(typed("nv"), loaded("nv", [NVDA, NVDL])))).toMatch(/^2 results\. Use the up and down arrow keys/);
    expect(searchAnnouncement(run(typed("nvidia"), loaded("nvidia", [NVDA])))).toMatch(/^1 result\./);
    expect(searchAnnouncement(run(typed("zzz"), loaded("zzz", [])))).toBe("No US stocks or ETFs match “zzz”.");
    expect(searchAnnouncement(run(typed("nv"), { type: "failed", query: "nv", message: "Search is down." }))).toBe(
      "Search is down.",
    );
    expect(searchAnnouncement(run(typed("nv"), loaded("nv", [NVDA]), { type: "close" }))).toBe("");
  });
});
