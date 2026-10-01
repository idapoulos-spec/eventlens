import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { StockSearchResult } from "@/lib/search/types";

const NVDA: StockSearchResult = { symbol: "NVDA", name: "NVIDIA Corporation", exchange: "NASDAQ", type: "Common Stock" };

type Reply = () => Response | Promise<Response>;

function stubSearchApi(reply: Reply) {
  const urls: string[] = [];
  vi.stubGlobal("fetch", async (input: string, init?: RequestInit) => {
    urls.push(input);
    if (init?.signal?.aborted) throw new DOMException("The operation was aborted.", "AbortError");
    return reply();
  });
  return urls;
}

// The result cache lives in module state, so each test imports a fresh copy of the module.
let client: typeof import("./StockSearchFetch");

beforeEach(async () => {
  vi.resetModules();
  client = await import("./StockSearchFetch");
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("fetchStockResults", () => {
  it("requests the search route and returns its results", async () => {
    const urls = stubSearchApi(() => Response.json({ query: "nvidia corp", results: [NVDA] }));
    expect(await client.fetchStockResults("nvidia corp")).toEqual({ ok: true, query: "nvidia corp", results: [NVDA] });
    expect(urls).toEqual(["/api/search/stocks?q=nvidia+corp"]);
  });

  it("remembers results, so an earlier query shows again without a request", async () => {
    stubSearchApi(() => Response.json({ query: "nv", results: [NVDA] }));
    expect(client.cachedStockResults("nv")).toBeUndefined();
    await client.fetchStockResults("nv");
    expect(client.cachedStockResults("nv")).toEqual([NVDA]);
  });

  it("shows the route's error message", async () => {
    stubSearchApi(() =>
      Response.json({ error: { code: "rate_limited", message: "Too many searches. Please wait a moment and try again." } }, { status: 429 }),
    );
    expect(await client.fetchStockResults("nv")).toEqual({
      ok: false,
      query: "nv",
      message: "Too many searches. Please wait a moment and try again.",
    });
    expect(client.cachedStockResults("nv")).toBeUndefined();
  });

  it("falls back to a fixed message for a response it can't read", async () => {
    stubSearchApi(() => new Response("<html>Bad gateway</html>", { status: 502 }));
    const outcome = await client.fetchStockResults("nv");
    expect(outcome).toMatchObject({ ok: false, message: "Stock search isn't available right now. You can still enter a ticker." });
  });

  it("reports a network failure", async () => {
    stubSearchApi(() => Promise.reject(new TypeError("Failed to fetch")));
    expect(await client.fetchStockResults("nv")).toMatchObject({ ok: false, message: expect.stringMatching(/^Couldn't reach/) });
  });

  it("resolves to null when a newer query aborts the request", async () => {
    stubSearchApi(() => Response.json({ query: "nv", results: [NVDA] }));
    const controller = new AbortController();
    controller.abort();
    expect(await client.fetchStockResults("nv", controller.signal)).toBeNull();
    expect(client.cachedStockResults("nv")).toBeUndefined();
  });
});

describe("unlistedTickerMatch", () => {
  it("returns the best result for text the search found to be a name, not a ticker", async () => {
    stubSearchApi(() => Response.json({ query: "nvidia", results: [NVDA] }));
    // Nothing is known before the search has run.
    expect(client.unlistedTickerMatch("nvidia")).toBeNull();
    await client.fetchStockResults("nvidia");
    expect(client.unlistedTickerMatch(" nvidia ")).toEqual(NVDA);
  });

  it("returns null for a listed ticker, or text the search found nothing for", async () => {
    stubSearchApi(() => Response.json({ query: "nvda", results: [NVDA] }));
    await client.fetchStockResults("nvda");
    expect(client.unlistedTickerMatch("nvda")).toBeNull();

    stubSearchApi(() => Response.json({ query: "zzzz", results: [] }));
    await client.fetchStockResults("zzzz");
    expect(client.unlistedTickerMatch("zzzz")).toBeNull();
  });
});
