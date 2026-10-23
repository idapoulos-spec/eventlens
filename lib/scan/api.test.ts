import { describe, expect, it } from "vitest";
import { MAX_SCAN_CANDIDATES } from "@/lib/analytics/scan";
import { parseSeries, parseSpan, parseTickers, perMinuteLimit, spanParams } from "./api";

describe("the scan routes' parameters", () => {
  it("read a series ticker", () => {
    expect(parseSeries(" kxfeddecision ")).toEqual({ ok: true, value: "KXFEDDECISION" });
    expect(parseSeries("KX FED").ok).toBe(false);
    expect(parseSeries(null).ok).toBe(false);
  });

  it("read a custom list, once per ticker, up to the scan's limit", () => {
    expect(parseTickers("kxfeddecision-26dec, KXCPI-26OCT-T0.3\nKXFEDDECISION-26DEC")).toEqual({ ok: true, value: ["KXFEDDECISION-26DEC", "KXCPI-26OCT-T0.3"] });
    expect(parseTickers("").ok).toBe(false);
    expect(parseTickers("not a ticker!").ok).toBe(false);
    expect(parseTickers(Array.from({ length: MAX_SCAN_CANDIDATES + 1 }, (_, i) => `KXA-${i}`).join(",")).ok).toBe(false);
  });

  it("read the span the page computed, running to now when it's live", () => {
    const now = Date.UTC(2026, 9, 21, 18);
    const span = { from: Date.UTC(2026, 6, 13), to: now - 5_000, live: true };
    expect(parseSpan(spanParams(span), now)).toEqual({ ok: true, value: { ...span, to: now } });
    expect(parseSpan(new URLSearchParams({ from: "5", to: "10" }), now).ok).toBe(false);
    expect(parseSpan(new URLSearchParams({ from: String(now - 1000), to: String(now + 3_600_000) }), now).ok).toBe(false);
  });
});

describe("perMinuteLimit", () => {
  it("asks the page to try again 2 s into the next minute, when Twelve Data's minute starts over", async () => {
    const response = perMinuteLimit("Twelve Data rate limit reached.", Date.UTC(2026, 9, 22, 15, 30, 17, 400));
    expect(response.status).toBe(429);
    expect(response.headers.get("Retry-After")).toBe("45");
    expect((await response.json()).error.code).toBe("upstream_rate_limited");
  });
});
