import { NextRequest } from "next/server";
import { describe, expect, it } from "vitest";
import type { StockSearchResponse, SearchErrorResponse } from "@/lib/search/types";
import { GET } from "./route";

// The limiter lives in module state, so each test uses its own IP.
function search(query: string | null, ip: string) {
  const url = new URL("http://localhost/api/search/stocks");
  if (query !== null) url.searchParams.set("q", query);
  return GET(new NextRequest(url, { headers: { "x-real-ip": ip } }));
}

describe("GET /api/search/stocks", () => {
  it("returns the normalized query and a result list", async () => {
    const res = await search("  fed   hike ", "10.0.0.1");
    expect(res.status).toBe(200);
    const body: StockSearchResponse = await res.json();
    expect(body).toEqual({ query: "fed hike", results: [] });
  });

  it("rejects a missing or blank query with 400", async () => {
    for (const query of [null, "   "]) {
      const res = await search(query, "10.0.0.2");
      expect(res.status).toBe(400);
      const body: SearchErrorResponse = await res.json();
      expect(body.error.code).toBe("invalid_query");
    }
  });

  it("rate-limits each IP with 429 and Retry-After, without counting invalid queries", async () => {
    for (let i = 0; i < 40; i++) await search("", "10.0.0.3");
    for (let i = 0; i < 30; i++) expect((await search("nv", "10.0.0.3")).status).toBe(200);

    const limited = await search("nv", "10.0.0.3");
    expect(limited.status).toBe(429);
    expect(Number(limited.headers.get("Retry-After"))).toBeGreaterThan(0);
    const body: SearchErrorResponse = await limited.json();
    expect(body.error.code).toBe("rate_limited");

    expect((await search("nv", "10.0.0.4")).status).toBe(200);
  });
});
