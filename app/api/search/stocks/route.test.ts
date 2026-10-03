import { NextRequest } from "next/server";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { signedInCookie } from "@/lib/auth/test-helpers";
import { searchUsStocks } from "@/lib/market-data";
import { fail, ok } from "@/lib/result";
import type { StockSearchResponse, SearchErrorResponse, StockSearchResult } from "@/lib/search/types";
import { GET } from "./route";

// The symbol lists and their daily download are tested in lib/market-data.
vi.mock("@/lib/market-data", () => ({ searchUsStocks: vi.fn() }));
const searchMock = vi.mocked(searchUsStocks);

const NVDA: StockSearchResult = { symbol: "NVDA", name: "NVIDIA Corporation", exchange: "NASDAQ", type: "Common Stock" };

afterEach(() => {
  searchMock.mockReset();
});

// Every request below is signed in, except where a test says otherwise.
let cookie = "";
beforeAll(async () => {
  cookie = await signedInCookie();
});
afterAll(() => {
  vi.unstubAllEnvs();
});

// The limiter lives in module state, so each test uses its own IP.
function search(query: string | null, ip: string, signedIn = true) {
  const url = new URL("http://localhost/api/search/stocks");
  if (query !== null) url.searchParams.set("q", query);
  return GET(new NextRequest(url, { headers: { "x-real-ip": ip, ...(signedIn && { cookie }) } }));
}

describe("GET /api/search/stocks", () => {
  it("turns away a visitor who isn't signed in with 401, before validating or searching", async () => {
    for (const query of ["nvda", null]) {
      const res = await search(query, "10.0.0.9", false);
      expect(res.status).toBe(401);
      const body: SearchErrorResponse = await res.json();
      expect(body.error.code).toBe("unauthorized");
    }
    expect(searchMock).not.toHaveBeenCalled();
  });

  it("searches for the normalized query and returns it with the results", async () => {
    searchMock.mockResolvedValue(ok([NVDA]));
    const res = await search("  nvidia   corp ", "10.0.0.1");
    expect(res.status).toBe(200);
    const body: StockSearchResponse = await res.json();
    expect(body).toEqual({ query: "nvidia corp", results: [NVDA] });
    expect(searchMock).toHaveBeenCalledWith("nvidia corp");
  });

  it("rejects a missing or blank query with 400, without searching", async () => {
    for (const query of [null, "   "]) {
      const res = await search(query, "10.0.0.2");
      expect(res.status).toBe(400);
      const body: SearchErrorResponse = await res.json();
      expect(body.error.code).toBe("invalid_query");
    }
    expect(searchMock).not.toHaveBeenCalled();
  });

  it.each([
    ["missing_key", 503],
    ["rate_limited", 503],
    ["timeout", 504],
    ["auth", 502],
    ["unavailable", 502],
    ["upstream", 502],
  ])("responds to a %s search error with %i and the error envelope", async (code, status) => {
    searchMock.mockResolvedValue(fail(code, "Stock search is unavailable. You can still enter a ticker."));
    const res = await search("nvda", `error-${code}`);
    expect(res.status).toBe(status);
    const body: SearchErrorResponse = await res.json();
    expect(body).toEqual({ error: { code, message: "Stock search is unavailable. You can still enter a ticker." } });
  });

  it("rate-limits each IP with 429 and Retry-After, without counting invalid queries", async () => {
    searchMock.mockResolvedValue(ok([]));
    for (let i = 0; i < 40; i++) await search("", "10.0.0.3");
    for (let i = 0; i < 30; i++) expect((await search("nv", "10.0.0.3")).status).toBe(200);

    const limited = await search("nv", "10.0.0.3");
    expect(limited.status).toBe(429);
    expect(Number(limited.headers.get("Retry-After"))).toBeGreaterThan(0);
    const body: SearchErrorResponse = await limited.json();
    expect(body.error.code).toBe("rate_limited");
    expect(searchMock).toHaveBeenCalledTimes(30);

    expect((await search("nv", "10.0.0.4")).status).toBe(200);
  });
});
