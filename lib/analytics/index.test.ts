import { describe, expect, it } from "vitest";
import * as analytics from "@/lib/analytics";

describe("@/lib/analytics", () => {
  it("re-exports the public analytics API", () => {
    expect(Object.keys(analytics).sort()).toEqual([
      "HOUR_MS",
      "MIN_KALSHI_MOVES",
      "MIN_PAIRS",
      "RESEARCH_CSV_COLUMNS",
      "SMALL_EVENT_COUNT",
      "SMALL_SAMPLE",
      "TRADING_DAYS_PER_YEAR",
      "alignSeries",
      "binaryEntropy",
      "buildResearchRows",
      "computeChanges",
      "correlationStats",
      "crossCorrelation",
      "csvField",
      "eventStudy",
      "impliedProbability",
      "logReturns",
      "mergeSeries",
      "pearson",
      "probabilityChange",
      "realizedVolatility",
      "relativeVolume",
      "researchCsv",
      "rollingCorrelation",
      "rowsSince",
      "sampleFlag",
      "sampleStdDev",
      "topOfHourCloses",
      "uncertaintyScore",
    ]);
  });
});
