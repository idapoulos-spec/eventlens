import { describe, expect, it } from "vitest";
import * as analytics from "@/lib/analytics";

describe("@/lib/analytics", () => {
  it("re-exports the public analytics API", () => {
    expect(Object.keys(analytics).sort()).toEqual([
      "HOUR_MS",
      "TRADING_DAYS_PER_YEAR",
      "alignSeries",
      "binaryEntropy",
      "impliedProbability",
      "logReturns",
      "mergeSeries",
      "probabilityChange",
      "realizedVolatility",
      "relativeVolume",
      "sampleStdDev",
      "uncertaintyScore",
    ]);
  });
});
