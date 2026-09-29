import { after, NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { pendingKalshiIndexRefresh, searchKalshiMarkets } from "@/lib/kalshi/search";
import { fail, ok } from "@/lib/result";
import type { KalshiSearchResponse, KalshiSearchResult, SearchErrorResponse } from "@/lib/search/types";
import { GET } from "./route";

// `after` needs Next's request scope, which a direct call to GET doesn't have.
vi.mock("next/server", async (importOriginal) => ({ ...(await importOriginal<object>()), after: vi.fn() }));
vi.mock("@/lib/kalshi/search", () => ({
  searchKalshiMarkets: vi.fn(),
  pendingKalshiIndexRefresh: vi.fn(),
  FAILED_BUILD_BACKOFF_SEC: 30,
}));

const RESULT: KalshiSearchResult = {
  ticker: "KXFEDDECISION-26OCT-H25",
  title: "Will the Fed hike rates by 25bps in October 2026?",
  eventTitle: "Fed decision in October 2026",
  category: "Economics",
  status: "open",
  closeTime: "2026-10-28T18:00:00Z",
  probability: 0.04,
};

// The limiter lives in module state, so each test uses its own IP.
function search(query: string | null, ip: string) {
  const url = new URL("http://localhost/api/search/kalshi");
  if (query !== null) url.searchParams.set("q", query);
  return GET(new NextRequest(url, { headers: { "x-real-ip": ip } }));
}

beforeEach(() => {
  vi.mocked(searchKalshiMarkets).mockReset().mockResolvedValue(ok([RESULT]));
  vi.mocked(after).mockClear();
});

describe("GET /api/search/kalshi", () => {
  it("searches for the normalized query and returns the results", async () => {
    const res = await search("  fed   hike ", "10.0.0.1");
    expect(res.status).toBe(200);
    const body: KalshiSearchResponse = await res.json();
    expect(body).toEqual({ query: "fed hike", results: [RESULT] });
    expect(searchKalshiMarkets).toHaveBeenCalledWith("fed hike");
  });

  it("keeps running after responding until a background index refresh finishes", async () => {
    const refresh = Promise.resolve();
    vi.mocked(pendingKalshiIndexRefresh).mockReturnValue(refresh);
    await search("fed", "10.0.0.5");

    expect(after).toHaveBeenCalledOnce();
    const task = vi.mocked(after).mock.calls[0][0] as () => unknown;
    expect(task()).toBe(refresh);
  });

  it("rejects a missing or blank query with 400, without searching", async () => {
    for (const query of [null, "   "]) {
      const res = await search(query, "10.0.0.2");
      expect(res.status).toBe(400);
      const body: SearchErrorResponse = await res.json();
      expect(body.error.code).toBe("invalid_query");
    }
    expect(searchKalshiMarkets).not.toHaveBeenCalled();
  });

  it("rate-limits each IP with 429 and Retry-After, without counting invalid queries", async () => {
    for (let i = 0; i < 40; i++) await search("", "10.0.0.3");
    for (let i = 0; i < 30; i++) expect((await search("nv", "10.0.0.3")).status).toBe(200);

    const limited = await search("nv", "10.0.0.3");
    expect(limited.status).toBe(429);
    expect(Number(limited.headers.get("Retry-After"))).toBeGreaterThan(0);
    const body: SearchErrorResponse = await limited.json();
    expect(body.error.code).toBe("rate_limited");
    expect(searchKalshiMarkets).toHaveBeenCalledTimes(30);

    expect((await search("nv", "10.0.0.4")).status).toBe(200);
  });

  it("reports Kalshi failures as server errors in the error envelope", async () => {
    const cases = [
      { code: "upstream_rate_limited", status: 503, retryAfter: "30" },
      { code: "upstream_timeout", status: 504, retryAfter: null },
      { code: "upstream_unavailable", status: 502, retryAfter: null },
    ];
    for (const [i, { code, status, retryAfter }] of cases.entries()) {
      vi.mocked(searchKalshiMarkets).mockResolvedValueOnce(fail(code, `Message for ${code}`));
      const res = await search("fed", `10.0.1.${i}`);
      expect(res.status).toBe(status);
      expect(res.headers.get("Retry-After")).toBe(retryAfter);
      const body: SearchErrorResponse = await res.json();
      expect(body).toEqual({ error: { code, message: `Message for ${code}` } });
    }
  });
});
