import { afterEach, describe, expect, it, vi } from "vitest";
import { HOUR_MS, impliedProbability, probabilityChange } from "./probability";
import type { TimePoint } from "./types";

describe("HOUR_MS", () => {
  it("is one hour in milliseconds", () => {
    expect(HOUR_MS).toBe(3_600_000);
  });
});

describe("impliedProbability", () => {
  it("uses the bid/ask midpoint when both sides are quoted", () => {
    const estimate = impliedProbability(0.4, 0.44, 0.9);
    expect(estimate.source).toBe("midpoint");
    expect(estimate.value).toBeCloseTo(0.42, 12);
  });

  it("uses the midpoint when bid equals ask", () => {
    expect(impliedProbability(0.5, 0.5)).toEqual({ value: 0.5, source: "midpoint" });
  });

  it("uses the midpoint for quotes near 0% and 100%", () => {
    expect(impliedProbability(0.01, 0.02).value).toBeCloseTo(0.015, 12);
    expect(impliedProbability(0.98, 0.99).value).toBeCloseTo(0.985, 12);
  });

  it("falls back to the last price when the bid is missing", () => {
    expect(impliedProbability(null, 0.6, 0.55)).toEqual({ value: 0.55, source: "last_price" });
  });

  it("falls back to the last price when the ask is missing", () => {
    expect(impliedProbability(0.4, null, 0.45)).toEqual({ value: 0.45, source: "last_price" });
  });

  it("falls back to the last price when both bid and ask are missing", () => {
    expect(impliedProbability(null, null, 0.3)).toEqual({ value: 0.3, source: "last_price" });
  });

  it("treats a bid of 0 as an empty bid side", () => {
    expect(impliedProbability(0, 0.1, 0.05)).toEqual({ value: 0.05, source: "last_price" });
  });

  it("treats an ask of 1 as an empty ask side", () => {
    expect(impliedProbability(0.9, 1, 0.95)).toEqual({ value: 0.95, source: "last_price" });
  });

  it("falls back when the book is empty on both sides (bid 0, ask 1)", () => {
    expect(impliedProbability(0, 1, 0.5)).toEqual({ value: 0.5, source: "last_price" });
  });

  it("falls back when the book is crossed (bid above ask)", () => {
    expect(impliedProbability(0.6, 0.5, 0.55)).toEqual({ value: 0.55, source: "last_price" });
  });

  it("ignores bids and asks outside 0–1 or not finite", () => {
    expect(impliedProbability(-0.1, 0.5, 0.4).source).toBe("last_price");
    expect(impliedProbability(0.4, 1.5, 0.4).source).toBe("last_price");
    expect(impliedProbability(Number.NaN, 0.5, 0.4).source).toBe("last_price");
    expect(impliedProbability(0.4, Number.POSITIVE_INFINITY, 0.4).source).toBe("last_price");
  });

  it("is unavailable with no usable quote and no last price", () => {
    expect(impliedProbability(null, null)).toEqual({ value: null, source: "unavailable" });
    expect(impliedProbability(null, null, null)).toEqual({ value: null, source: "unavailable" });
    expect(impliedProbability(0, 1)).toEqual({ value: null, source: "unavailable" });
  });

  it("treats a last price of 0 as no trade", () => {
    expect(impliedProbability(null, null, 0)).toEqual({ value: null, source: "unavailable" });
  });

  it("ignores a last price outside 0–1 or not finite", () => {
    expect(impliedProbability(null, null, 1.2).source).toBe("unavailable");
    expect(impliedProbability(null, null, -0.2).source).toBe("unavailable");
    expect(impliedProbability(null, null, Number.NaN).source).toBe("unavailable");
  });
});

describe("probabilityChange", () => {
  const asOf = Date.UTC(2026, 0, 2, 12);
  const history: TimePoint[] = [
    { t: asOf - 30 * HOUR_MS, value: 0.2 },
    { t: asOf - 26 * HOUR_MS, value: 0.3 },
    { t: asOf - 2 * HOUR_MS, value: 0.4 },
    { t: asOf - 30 * 60_000, value: 0.45 },
  ];

  afterEach(() => {
    vi.useRealTimers();
  });

  it("compares against the latest point at or before the lookback cutoff", () => {
    const change = probabilityChange(history, 0.5, HOUR_MS, asOf);
    expect(change.from).toBe(asOf - 2 * HOUR_MS);
    expect(change.pp).toBeCloseTo(10, 10);
  });

  it("uses the prevailing value when the last point is well before the cutoff", () => {
    const change = probabilityChange(history, 0.5, 24 * HOUR_MS, asOf);
    expect(change.from).toBe(asOf - 26 * HOUR_MS);
    expect(change.pp).toBeCloseTo(20, 10);
  });

  it("includes a point exactly at the cutoff", () => {
    const change = probabilityChange(history, 0.5, 2 * HOUR_MS, asOf);
    expect(change.from).toBe(asOf - 2 * HOUR_MS);
    expect(change.pp).toBeCloseTo(10, 10);
  });

  it("reports decreases as negative percentage points", () => {
    const change = probabilityChange(history, 0.25, HOUR_MS, asOf);
    expect(change.pp).toBeCloseTo(-15, 10);
  });

  it("returns zero when the probability has not moved", () => {
    expect(probabilityChange(history, 0.4, HOUR_MS, asOf).pp).toBe(0);
  });

  it("handles moves between 0% and 100%", () => {
    const flat: TimePoint[] = [{ t: asOf - 2 * HOUR_MS, value: 0 }];
    expect(probabilityChange(flat, 1, HOUR_MS, asOf)).toEqual({ pp: 100, from: asOf - 2 * HOUR_MS });
    const certain: TimePoint[] = [{ t: asOf - 2 * HOUR_MS, value: 1 }];
    expect(probabilityChange(certain, 0, HOUR_MS, asOf)).toEqual({ pp: -100, from: asOf - 2 * HOUR_MS });
  });

  it("returns null when history does not reach back far enough", () => {
    expect(probabilityChange(history, 0.5, 48 * HOUR_MS, asOf)).toEqual({ pp: null, from: null });
  });

  it("returns null for empty history", () => {
    expect(probabilityChange([], 0.5, HOUR_MS, asOf)).toEqual({ pp: null, from: null });
  });

  it("returns null when the current probability is unknown", () => {
    expect(probabilityChange(history, null, HOUR_MS, asOf)).toEqual({ pp: null, from: null });
  });

  it("measures from the current time by default", () => {
    vi.useFakeTimers();
    vi.setSystemTime(asOf);
    expect(probabilityChange(history, 0.5, HOUR_MS)).toEqual(probabilityChange(history, 0.5, HOUR_MS, asOf));
  });
});
