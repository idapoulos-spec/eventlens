import { afterEach, describe, expect, it, vi } from "vitest";
import type { KalshiSearchResult } from "@/lib/search/types";
import {
  fetchKalshiSearch,
  formatChance,
  formatCloses,
  initialSearchState,
  isKalshiSearchText,
  ResultCache,
  searchableQuery,
  searchReducer,
  type SearchAction,
  type SearchState,
} from "./KalshiSearchModel";

const result = (ticker: string): KalshiSearchResult => ({
  ticker,
  title: `Title ${ticker}`,
  eventTitle: "Event",
  category: "Economics",
  status: "open",
  closeTime: "2026-10-28T18:00:00Z",
  probability: 0.5,
});

const A = result("KXA-1-A");
const B = result("KXA-1-B");
const C = result("KXA-1-C");

const run = (actions: SearchAction[], from: SearchState = initialSearchState) => actions.reduce(searchReducer, from);

/** A popup showing A, B, and C for "fed". */
const loaded = run([
  { type: "input", query: "fed" },
  { type: "loaded", query: "fed", results: [A, B, C] },
]);

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("searchableQuery", () => {
  it("normalizes whitespace and skips text too short to search", () => {
    expect(searchableQuery("  fed   hike ")).toBe("fed hike");
    expect(searchableQuery("f")).toBeNull();
    expect(searchableQuery("   ")).toBeNull();
    expect(searchableQuery("📈📈")).toBe("📈📈"); // two characters, four UTF-16 units
  });
});

describe("searchReducer", () => {
  it("opens a loading popup on input and shows the results that arrive for it", () => {
    const loading = run([{ type: "input", query: "fed" }]);
    expect(loading).toMatchObject({ query: "fed", status: "loading", open: true, active: -1 });
    expect(loaded).toMatchObject({ status: "done", results: [A, B, C], open: true, active: -1 });
  });

  it("ignores responses for a query the user has typed past", () => {
    const state = run([{ type: "input", query: "fe" }, { type: "input", query: "fed" }]);
    expect(run([{ type: "loaded", query: "fe", results: [A] }], state)).toBe(state);
    expect(run([{ type: "failed", query: "fe", message: "boom" }], state)).toBe(state);
  });

  it("keeps the previous results up while the next query loads", () => {
    const next = run([{ type: "input", query: "fed h" }], loaded);
    expect(next).toMatchObject({ status: "loading", results: [A, B, C], active: -1 });
  });

  it("shows cached results at once, without loading", () => {
    const state = run([{ type: "input", query: "fed", cached: [B] }]);
    expect(state).toMatchObject({ status: "done", results: [B] });
  });

  it("closes and forgets the query when the text gets too short", () => {
    expect(run([{ type: "input", query: null }], loaded)).toEqual(initialSearchState);
  });

  it("moves the highlight with the arrow keys, wrapping at both ends", () => {
    const down = (n: number, from = loaded) => run(Array(n).fill({ type: "move", by: 1 }), from).active;
    expect(down(1)).toBe(0);
    expect(down(3)).toBe(2);
    expect(down(4)).toBe(0);
    expect(run([{ type: "move", by: -1 }], loaded).active).toBe(2);
    // Up from the first result wraps to the last.
    expect(run([{ type: "move", by: 1 }, { type: "move", by: -1 }], loaded).active).toBe(2);
  });

  it("reopens a closed popup with the arrow keys, highlighting the first or last result", () => {
    const closed = run([{ type: "move", by: 1 }, { type: "close" }], loaded);
    expect(closed).toMatchObject({ open: false, active: -1 });
    expect(run([{ type: "move", by: 1 }], closed)).toMatchObject({ open: true, active: 0 });
    expect(run([{ type: "move", by: -1 }], closed)).toMatchObject({ open: true, active: 2 });
    expect(run([{ type: "open" }], closed)).toMatchObject({ open: true, active: -1 });
  });

  it("does nothing on arrows or focus when there's no query", () => {
    expect(run([{ type: "move", by: 1 }, { type: "open" }])).toEqual(initialSearchState);
  });

  it("highlights only existing results", () => {
    expect(run([{ type: "highlight", index: 1 }], loaded).active).toBe(1);
    expect(run([{ type: "highlight", index: 3 }], loaded).active).toBe(-1);
  });

  it("shows an error, and retries the same query on request or on the next edit", () => {
    const failed = run([{ type: "input", query: "fed" }, { type: "failed", query: "fed", message: "Kalshi is down." }]);
    expect(failed).toMatchObject({ status: "error", error: "Kalshi is down.", results: [] });

    const retried = run([{ type: "retry" }], failed);
    expect(retried).toMatchObject({ status: "loading", error: null, attempt: failed.attempt + 1 });
    // Retrying only makes sense after an error.
    expect(run([{ type: "retry" }], loaded)).toBe(loaded);
    // Typing a space leaves the query as it was, but still searches again.
    expect(run([{ type: "input", query: "fed" }], failed)).toMatchObject({ status: "loading" });
  });

  it("flags a slow search only while that search is loading", () => {
    const loading = run([{ type: "input", query: "fed" }]);
    expect(run([{ type: "slow", query: "fed" }], loading).slow).toBe(true);
    expect(run([{ type: "slow", query: "fe" }], loading).slow).toBe(false);
    expect(run([{ type: "slow", query: "fed" }], loaded).slow).toBe(false);
    expect(run([{ type: "slow", query: "fed" }, { type: "loaded", query: "fed", results: [] }], loading).slow).toBe(false);
  });

  it("resets after a pick, so the popup stays closed until the user types", () => {
    const picked = run([{ type: "move", by: 1 }, { type: "reset" }], loaded);
    expect(picked).toMatchObject({ query: null, open: false, results: [] });
    expect(run([{ type: "open" }], picked).open).toBe(false);
  });
});

describe("fetchKalshiSearch", () => {
  function stubFetch(reply: () => Response | Promise<Response>) {
    const urls: string[] = [];
    vi.stubGlobal("fetch", async (input: string) => {
      urls.push(input);
      return reply();
    });
    return urls;
  }

  it("requests the route with the query and returns its results", async () => {
    const urls = stubFetch(() => Response.json({ query: "fed hike", results: [A] }));
    expect(await fetchKalshiSearch("fed hike")).toEqual({ ok: true, query: "fed hike", results: [A] });
    expect(urls).toEqual(["/api/search/kalshi?q=fed+hike"]);
  });

  it("shows the route's error message", async () => {
    stubFetch(() => Response.json({ error: { code: "upstream_timeout", message: "Kalshi didn't respond." } }, { status: 504 }));
    expect(await fetchKalshiSearch("fed")).toEqual({ ok: false, message: "Kalshi didn't respond." });
  });

  it("falls back to its own message when the error isn't JSON", async () => {
    stubFetch(() => new Response("<html>Too many</html>", { status: 429 }));
    expect(await fetchKalshiSearch("fed")).toEqual({ ok: false, message: expect.stringMatching(/too many searches/i) });
    stubFetch(() => new Response("<html>Gateway timeout</html>", { status: 504 }));
    expect(await fetchKalshiSearch("fed")).toEqual({ ok: false, message: expect.stringMatching(/type a market ticker/i) });
  });

  it("reports a network failure", async () => {
    stubFetch(() => {
      throw new TypeError("fetch failed");
    });
    expect(await fetchKalshiSearch("fed")).toEqual({ ok: false, message: expect.stringMatching(/connection/i) });
  });

  it("rejects when aborted, so a replaced search is dropped rather than shown as an error", async () => {
    const controller = new AbortController();
    stubFetch(() => {
      controller.abort();
      throw new DOMException("aborted", "AbortError");
    });
    await expect(fetchKalshiSearch("fed", controller.signal)).rejects.toThrow();
  });
});

describe("ResultCache", () => {
  it("returns results by query, ignoring case, until they expire", () => {
    const cache = new ResultCache(10, 1000);
    cache.set("Fed", [A], 0);
    expect(cache.get("fed", 999)).toEqual([A]);
    expect(cache.get("FED", 1000)).toBeUndefined();
  });

  it("evicts the least recently stored query", () => {
    const cache = new ResultCache(2, 1000);
    cache.set("a", [A], 0);
    cache.set("b", [B], 0);
    cache.set("a", [A], 0);
    cache.set("c", [C], 0);
    expect(cache.get("b", 0)).toBeUndefined();
    expect(cache.get("a", 0)).toEqual([A]);
    expect(cache.get("c", 0)).toEqual([C]);
  });
});

describe("isKalshiSearchText", () => {
  it("is true for text the field found markets for, none with it as its ticker", () => {
    const cache = new ResultCache();
    cache.set("recession", [A, B]);
    expect(isKalshiSearchText(" Recession ", cache)).toBe(true);
  });

  it("is false until the field has found markets for the text, since it could still be a ticker", () => {
    const cache = new ResultCache();
    cache.set("nothing", []);
    expect(isKalshiSearchText("inflation", cache)).toBe(false);
    expect(isKalshiSearchText("nothing", cache)).toBe(false);
  });

  it("is false for text with a '-', as every market ticker has, or a ticker among the results", () => {
    const cache = new ResultCache();
    cache.set("KXA-1", [A, B]);
    cache.set("kxodd", [result("KXODD")]);
    expect(isKalshiSearchText("KXA-1", cache)).toBe(false);
    expect(isKalshiSearchText("kxodd", cache)).toBe(false);
  });
});

describe("formatChance", () => {
  it("shows whole percents, but not 0% or 100% for a market that isn't settled", () => {
    expect(formatChance(0.4249)).toBe("42%");
    expect(formatChance(0.004)).toBe("<1%");
    expect(formatChance(0.996)).toBe(">99%");
    expect(formatChance(0)).toBe("0%");
    expect(formatChance(null)).toBe("—");
  });
});

describe("formatCloses", () => {
  const NOW = Date.UTC(2026, 8, 29, 16, 0); // Sep 29, 2026, 12:00 PM EDT

  it("shows the time for a market closing within a day, in New York time", () => {
    expect(formatCloses("2026-09-29T21:00:00Z", NOW)).toBe("Closes Sep 29, 5:00 PM EDT");
  });

  it("shows the date, with the year only when it isn't this year", () => {
    expect(formatCloses("2026-10-29T03:00:00Z", NOW)).toBe("Closes Oct 28"); // 11 PM EDT the day before
    expect(formatCloses("2045-01-01T15:00:00Z", NOW)).toBe("Closes Jan 1, 2045");
  });

  it("returns null without a valid close time", () => {
    expect(formatCloses(null, NOW)).toBeNull();
    expect(formatCloses("soon", NOW)).toBeNull();
  });
});
