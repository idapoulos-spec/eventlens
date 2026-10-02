import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getBenchmarkSeries } from "./benchmark";

// server-only throws outside React's server environment; the client only uses it as a marker.
vi.mock("server-only", () => ({}));

const NOW = Date.parse("2026-09-28T15:20:00Z"); // 11:20 AM New York

/** Fakes Twelve Data's time series; `fail` answers with its rate-limit error instead. */
function stubTwelveData({ fail = false } = {}) {
  const requests: { url: URL; init: RequestInit }[] = [];
  vi.stubGlobal("fetch", async (input: string | URL, init: RequestInit) => {
    const url = new URL(String(input));
    requests.push({ url, init });
    if (fail) return Response.json({ status: "error", code: 429, message: "You have run out of API credits" });
    const values =
      url.searchParams.get("interval") === "1day"
        ? [{ datetime: "2026-09-25", open: "1", high: "1", low: "1", close: "500" }]
        : [{ datetime: "2026-09-28 14:30:00", open: "1", high: "1", low: "1", close: "501" }];
    return Response.json({ status: "ok", meta: { exchange_timezone: "America/New_York" }, values });
  });
  return requests;
}

beforeEach(() => {
  vi.stubEnv("TWELVE_DATA_API_KEY", "test-key");
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

// The cache lives in module state, so each test uses its own symbol.
describe("getBenchmarkSeries", () => {
  it("fetches 30-minute and daily bars fresh, without a quote, and stamps them for research", async () => {
    const requests = stubTwelveData();
    const result = await getBenchmarkSeries("SPY");
    expect(requests.map((r) => r.url.searchParams.get("interval")).sort()).toEqual(["1day", "30min"]);
    expect(requests.every((r) => r.url.pathname === "/time_series" && r.init.cache === "no-store")).toBe(true);
    expect(result).toEqual({
      ok: true,
      data: {
        symbol: "SPY",
        hourly: [{ t: Date.parse("2026-09-28T15:00:00Z"), value: 501 }],
        daily: [{ t: Date.parse("2026-09-25T20:00:00Z"), value: 500 }],
        fetchedAt: NOW,
      },
    });
  });

  it("shares one download between concurrent requests and serves it from memory until the next bar settles", async () => {
    const requests = stubTwelveData();
    const [a, b] = await Promise.all([getBenchmarkSeries("QQQ"), getBenchmarkSeries("QQQ")]);
    expect(a).toEqual(b);
    expect(requests).toHaveLength(2);

    vi.setSystemTime(Date.parse("2026-09-28T15:34:59Z"));
    await getBenchmarkSeries("QQQ");
    expect(requests).toHaveLength(2);

    vi.setSystemTime(Date.parse("2026-09-28T15:35:00Z"));
    await getBenchmarkSeries("QQQ");
    expect(requests).toHaveLength(4);
  });

  it("doesn't cache a failure", async () => {
    const failing = stubTwelveData({ fail: true });
    const result = await getBenchmarkSeries("XLK");
    expect(result).toMatchObject({ ok: false, error: { code: "rate_limited" } });
    expect(failing).toHaveLength(2);

    const requests = stubTwelveData();
    expect((await getBenchmarkSeries("XLK")).ok).toBe(true);
    expect(requests).toHaveLength(2);
  });

  it("explains a missing API key without calling Twelve Data", async () => {
    vi.stubEnv("TWELVE_DATA_API_KEY", "");
    const requests = stubTwelveData();
    expect(await getBenchmarkSeries("XLF")).toMatchObject({ ok: false, error: { code: "missing_key" } });
    expect(requests).toHaveLength(0);
  });
});
