import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Result } from "@/lib/result";
import type { StockSearchResult } from "@/lib/search/types";

// server-only throws outside React's server environment; the client only uses it as a marker.
vi.mock("server-only", () => ({}));

const START = Date.UTC(2026, 8, 29, 14);
const HOUR_MS = 60 * 60 * 1000;
const KEY = "test-key";

const STOCKS = [
  { symbol: "AAPL", name: "Apple Inc.", exchange: "NASDAQ", type: "Common Stock" },
  { symbol: "NVDA", name: "NVIDIA Corporation", exchange: "NASDAQ", type: "Common Stock" },
];
const ETFS = [{ symbol: "SPY", name: "State Street SPDR S&P 500 ETF Trust", exchange: "NYSE" }];

type Reply = (path: string) => Response | Promise<Response>;

const lists: Reply = (path) => Response.json({ data: path === "/stocks" ? STOCKS : ETFS, count: 2, status: "ok" });

/** Fakes Twelve Data's list endpoints and records every request. */
function stubTwelveData(reply: Reply = lists) {
  const requests: { url: URL; init: RequestInit }[] = [];
  vi.stubGlobal("fetch", async (input: string | URL, init: RequestInit) => {
    const url = new URL(String(input));
    requests.push({ url, init });
    return reply(url.pathname);
  });
  return requests;
}

// The index lives in module state, so each test imports a fresh copy of the module.
let search: (query: string) => Promise<Result<StockSearchResult[]>>;

beforeEach(async () => {
  vi.resetModules();
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(START);
  vi.stubEnv("TWELVE_DATA_API_KEY", KEY);
  ({ searchUsStocks: search } = await import("./symbol-search"));
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

const later = (ms: number) => vi.setSystemTime(Date.now() + ms);

async function symbols(query: string) {
  const result = await search(query);
  if (!result.ok) throw new Error(`Expected results, got ${result.error.code}`);
  return result.data.map((r) => r.symbol);
}

async function errorCode(query: string) {
  const result = await search(query);
  if (result.ok) throw new Error("Expected an error");
  return result.error.code;
}

describe("searchUsStocks", () => {
  it("downloads the US stock and ETF lists once, then answers every search from memory", async () => {
    const requests = stubTwelveData();

    // Searches that arrive while the lists download wait for the same download.
    const first = await Promise.all([symbols("apple"), symbols("nv"), symbols("spy")]);
    expect(first).toEqual([["AAPL"], ["NVDA"], ["SPY"]]);
    for (const query of ["a", "ap", "app", "appl", "apple", "nvidia", "s&p 500"]) await symbols(query);
    later(23 * HOUR_MS);
    expect(await symbols("NVDA")).toEqual(["NVDA"]);

    expect(requests.map((r) => r.url.pathname).sort()).toEqual(["/etfs", "/stocks"]);
    for (const { url, init } of requests) {
      expect(url.origin).toBe("https://api.twelvedata.com");
      expect(url.searchParams.get("country")).toBe("United States");
      // The key goes in a header, never the URL.
      expect(url.search).not.toContain(KEY);
      expect(new Headers(init.headers).get("Authorization")).toBe(`apikey ${KEY}`);
      // Too big for Next.js's data cache, which rejects entries over 2 MB.
      expect(init.cache).toBe("no-store");
    }
  });

  it("downloads the lists again after a day", async () => {
    const requests = stubTwelveData();
    await symbols("apple");
    later(24 * HOUR_MS);
    await symbols("apple");
    expect(requests).toHaveLength(4);
  });

  it("after a failed download, returns the error for five minutes without retrying, then retries", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    let status = 429;
    const requests = stubTwelveData((path) =>
      status === 200 ? lists(path) : Response.json({ status: "error", code: status, message: "API credits exhausted" }),
    );

    expect(await errorCode("apple")).toBe("rate_limited");
    later(5 * 60_000 - 1);
    expect(await errorCode("apple")).toBe("rate_limited");
    expect(requests).toHaveLength(2);

    status = 200;
    later(1);
    expect(await symbols("apple")).toEqual(["AAPL"]);
    expect(requests).toHaveLength(4);
  });

  it("keeps searching the previous day's lists when the daily download fails", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    let failing = false;
    const requests = stubTwelveData((path) => (failing ? new Response("Bad gateway", { status: 502 }) : lists(path)));
    await symbols("apple");

    failing = true;
    later(25 * HOUR_MS);
    expect(await symbols("apple")).toEqual(["AAPL"]);
    expect(await symbols("nvidia")).toEqual(["NVDA"]);
    // One failed attempt (2 requests), not one per search.
    expect(requests).toHaveLength(4);
  });

  it("reports a missing API key without calling Twelve Data", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.stubEnv("TWELVE_DATA_API_KEY", "");
    const requests = stubTwelveData();
    expect(await errorCode("apple")).toBe("missing_key");
    expect(requests).toHaveLength(0);
  });

  it.each([
    ["an invalid key", () => Response.json({ status: "error", code: 401, message: `bad key ${KEY}` }), "auth"],
    ["an HTTP error", () => new Response("Service unavailable", { status: 503 }), "upstream"],
    ["a response without a list", () => Response.json({ status: "ok" }), "upstream"],
    ["empty lists", () => Response.json({ data: [], status: "ok" }), "upstream"],
    [
      "a timeout",
      () => Promise.reject(new DOMException("The operation was aborted due to timeout", "TimeoutError")),
      "timeout",
    ],
    ["a network failure", () => Promise.reject(new TypeError("fetch failed")), "unavailable"],
  ] satisfies [string, Reply, string][])("maps %s to a fixed error message", async (_, reply, code) => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    stubTwelveData(reply);

    const result = await search("apple");
    expect(result).toMatchObject({ ok: false, error: { code } });
    if (!result.ok) expect(result.error.message).toMatch(/You can still enter a ticker\.$/);
    // Twelve Data's own text is logged with the key redacted, and never shown.
    expect(logged).toHaveBeenCalled();
    expect(JSON.stringify(logged.mock.calls)).not.toContain(KEY);
  });
});
