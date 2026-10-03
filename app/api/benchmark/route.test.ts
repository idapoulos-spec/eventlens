import { NextRequest } from "next/server";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { signedInCookie } from "@/lib/auth/test-helpers";
import { getBenchmarkSeries, type BenchmarkErrorResponse, type BenchmarkSeries } from "@/lib/market-data";
import { fail, ok } from "@/lib/result";
import { GET } from "./route";

// The download and its cache are tested in lib/market-data.
vi.mock("@/lib/market-data", () => ({ getBenchmarkSeries: vi.fn(), BENCHMARK_SYMBOL_PARAM: "symbol" }));
const benchmarkMock = vi.mocked(getBenchmarkSeries);

const QQQ: BenchmarkSeries = { symbol: "QQQ", hourly: [{ t: 1, value: 500 }], daily: [], fetchedAt: 2 };

afterEach(() => {
  benchmarkMock.mockReset();
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
function load(symbol: string | null, ip: string, signedIn = true) {
  const url = new URL("http://localhost/api/benchmark");
  if (symbol !== null) url.searchParams.set("symbol", symbol);
  return GET(new NextRequest(url, { headers: { "x-real-ip": ip, ...(signedIn && { cookie }) } }));
}

describe("GET /api/benchmark", () => {
  it("turns away a visitor who isn't signed in with 401, before validating or fetching", async () => {
    for (const symbol of ["QQQ", "not a ticker"]) {
      const res = await load(symbol, "10.0.1.9", false);
      expect(res.status).toBe(401);
      const body: BenchmarkErrorResponse = await res.json();
      expect(body.error.code).toBe("unauthorized");
    }
    expect(benchmarkMock).not.toHaveBeenCalled();
  });

  it("returns the benchmark for the normalized symbol", async () => {
    benchmarkMock.mockResolvedValue(ok(QQQ));
    const res = await load(" qqq ", "10.0.1.1");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(QQQ);
    expect(benchmarkMock).toHaveBeenCalledWith("QQQ");
  });

  it("rejects a missing or invalid symbol with 400, without fetching", async () => {
    for (const symbol of [null, "", "not a ticker"]) {
      const res = await load(symbol, "10.0.1.2");
      expect(res.status).toBe(400);
      const body: BenchmarkErrorResponse = await res.json();
      expect(body.error.code).toBe("invalid_symbol");
    }
    expect(benchmarkMock).not.toHaveBeenCalled();
  });

  it.each([
    ["missing_key", 503],
    ["rate_limited", 503],
    ["timeout", 504],
    ["not_found", 404],
    ["plan", 403],
    ["upstream", 502],
  ])("responds to a %s error with %i and the error envelope", async (code, status) => {
    benchmarkMock.mockResolvedValue(fail(code, "Twelve Data couldn't help."));
    const res = await load("XLK", `error-${code}`);
    expect(res.status).toBe(status);
    expect(await res.json()).toEqual({ error: { code, message: "Twelve Data couldn't help." } });
  });

  it("rate-limits each IP with 429 and Retry-After, without counting invalid symbols", async () => {
    benchmarkMock.mockResolvedValue(ok(QQQ));
    for (let i = 0; i < 10; i++) await load("", "10.0.1.3");
    for (let i = 0; i < 5; i++) expect((await load("QQQ", "10.0.1.3")).status).toBe(200);

    const limited = await load("QQQ", "10.0.1.3");
    expect(limited.status).toBe(429);
    expect(Number(limited.headers.get("Retry-After"))).toBeGreaterThan(0);
    expect(((await limited.json()) as BenchmarkErrorResponse).error.code).toBe("rate_limited");
    expect(benchmarkMock).toHaveBeenCalledTimes(5);
  });
});
