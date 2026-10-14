import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { computeChanges } from "./changes";
import { researchCsv } from "./csv";
import { eventStudy, eventWindowRows } from "./event-study";
import { crossCorrelation } from "./lead-lag";
import { marketAdjustment } from "./market-model";
import { HOUR_MS } from "./probability";
import { buildResearchRows, type ResearchRow } from "./research";
import { rollingCorrelation } from "./rolling";
import { simulateMarketRows } from "./test-helpers";

// Pins a single market's Research outputs, CSV bytes included, as they were before the analytics
// became unit-neutral (expected values in bp alongside probabilities in pp). Field names are
// normalized before hashing, so only values, order, and the CSV's text count. The pins were taken
// on the code before that change (bf6d488, with the rounding in canon).

const sha = (text: string) => createHash("sha256").update(text).digest("hex").slice(0, 16);

const RENAMED: Record<string, string> = { probChangePp: "x", kalshiChange: "x", probability: "v", kalshiValue: "v", thresholdPp: "th", threshold: "th" };

/**
 * JSON with renamed fields under one name, typed arrays as plain arrays, undefined left out, and
 * numbers to 9 significant digits: Math.log can differ in its last bit between CPUs (CI runs x64,
 * a Mac arm64), which a renamed field or a wrong scale never stays within.
 */
function canon(value: unknown): string {
  return JSON.stringify(value, function (key, v) {
    if (typeof v === "number" && Number.isFinite(v)) return Number(v.toPrecision(9));
    if (ArrayBuffer.isView(v) && !(v instanceof DataView)) return Array.from(v as unknown as ArrayLike<number>, (x) => Number(x.toPrecision(9)));
    if (v && typeof v === "object" && !Array.isArray(v)) {
      return Object.fromEntries(Object.entries(v).map(([k, x]) => [RENAMED[k] ?? k, x]));
    }
    return v;
  });
}

// Mon, Sep 28, 2026, 10:00 AM New York (EDT): three sessions of top-of-hour closes.
const SESSION = Date.parse("2026-09-28T14:00:00Z");

/** Rows with every row exclusion: before Kalshi's first price, a last-trade price, and after the close. */
function mixedRows(): ResearchRow[] {
  const stock = [];
  const kalshi = [];
  for (let d = 0; d < 3; d++) {
    for (let h = 0; h <= 6; h++) {
      const t = SESSION + d * 24 * HOUR_MS + h * HOUR_MS;
      stock.push({ t, value: 100 * Math.exp(0.003 * Math.sin(d * 7 + h)) });
      if (d + h > 0) kalshi.push({ t: t - 30 * 60_000, value: 0.4 + 0.01 * ((d * 7 + h) % 5), source: (h === 4 ? "last_price" : "midpoint") as "last_price" | "midpoint" });
    }
  }
  return buildResearchRows({ stock, kalshi, closeTime: SESSION + 2 * 24 * HOUR_MS + 3 * HOUR_MS, resolution: "hourly" });
}

describe("single-market Research outputs are unchanged", () => {
  it("writes the same CSV and changes for rows with every exclusion", () => {
    const rows = mixedRows();
    const closesByT = new Map(rows.map((r, i) => [r.t, 400 + Math.cos(i)]));
    expect(sha(researchCsv(rows, "hourly"))).toBe("e199ecb6f8e383f8");
    expect(sha(researchCsv(rows, "hourly", { symbol: "SPY", closesByT, model: { alpha: 0.0001, beta: 1.2 } }))).toBe("23d93e10720ab016");
    expect(sha(canon(computeChanges(rows, 100)))).toBe("6e9351ad2373a4a6");
  });

  for (const resolution of ["hourly", "daily"] as const) {
    it(`gives the same ${resolution} statistics, event study, and market adjustment`, () => {
      const { rows, closesByT } = simulateMarketRows({ sessions: resolution === "hourly" ? 40 : 60, resolution, seed: 31, effect: 0.05, sharedVolatility: true });
      const series = computeChanges(rows, 100);
      const event = { threshold: 1.5, before: 4, after: 4 };
      const study = eventStudy(rows, series.changes, event);
      const market = marketAdjustment({ full: rows, rows, changes: series.changes, scale: 100, closesByT, event, resolution });
      expect(sha(researchCsv(rows, resolution, { symbol: "SPY", closesByT, model: market.model }))).toBe({ hourly: "62fbef227e9fa7bd", daily: "a208ab4576f7993e" }[resolution]);
      expect(sha(canon(series))).toBe({ hourly: "6143e300ae59c999", daily: "6ae028c74c7c7ccd" }[resolution]);
      expect(sha(canon(study))).toBe({ hourly: "34a2e9aa33781ee1", daily: "a7d96a53367d239c" }[resolution]);
      expect(sha(canon([...eventWindowRows(rows, series.changes, event)]))).toBe({ hourly: "203d39080bf568e2", daily: "b2a91cd0ade19e7e" }[resolution]);
      expect(sha(canon(crossCorrelation(series.changes, 3, resolution)))).toBe({ hourly: "d2e376615ffdd1b6", daily: "19c1427e3e22cea8" }[resolution]);
      expect(sha(canon(rollingCorrelation(series.changes, 18)))).toBe({ hourly: "29ed8190986312ab", daily: "a33eb7f48b369f1e" }[resolution]);
      expect(sha(canon(market))).toBe({ hourly: "f2eb4ed6bfa2b9af", daily: "4011284222b83255" }[resolution]);
    });
  }
});
