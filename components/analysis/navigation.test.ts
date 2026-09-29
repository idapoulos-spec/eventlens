import { describe, expect, it } from "vitest";
import { analysisHref, REANALYZE_AFTER_MS, sameAnalysis, submitAction } from "./navigation";

const NVDA = { stock: "NVDA", kalshi: "KXFEDDECISION-26OCT-H25" };
const SPY = { stock: "SPY", kalshi: "KXRECSSNBER-27" };

describe("analysisHref", () => {
  it("puts both tickers in the home page's query string", () => {
    expect(analysisHref(NVDA)).toBe("/?stock=NVDA&kalshi=KXFEDDECISION-26OCT-H25");
  });

  it("encodes characters that are special in a query string", () => {
    expect(analysisHref({ stock: "BRK.B", kalshi: "KXA&B=C" })).toBe("/?stock=BRK.B&kalshi=KXA%26B%3DC");
  });
});

describe("sameAnalysis", () => {
  it("compares both tickers", () => {
    expect(sameAnalysis(NVDA, { ...NVDA })).toBe(true);
    expect(sameAnalysis(NVDA, { ...NVDA, stock: "AMD" })).toBe(false);
    expect(sameAnalysis(NVDA, { ...NVDA, kalshi: "KXRECSSNBER-27" })).toBe(false);
  });
});

describe("submitAction", () => {
  const now = 1_000_000;

  it("navigates to a different analysis, or from a page without one", () => {
    expect(submitAction(SPY, NVDA, now - 1000, now)).toBe("navigate");
    expect(submitAction(SPY, null, null, now)).toBe("navigate");
  });

  it("only reveals the results on screen while they are fresh", () => {
    expect(submitAction(NVDA, NVDA, now, now)).toBe("reveal");
    expect(submitAction(NVDA, NVDA, now - REANALYZE_AFTER_MS + 1, now)).toBe("reveal");
  });

  it("refreshes results once they are stale", () => {
    expect(submitAction(NVDA, NVDA, now - REANALYZE_AFTER_MS, now)).toBe("refresh");
  });

  it("refreshes the analysis in the URL when its results aren't showing (e.g. rate limited)", () => {
    expect(submitAction(NVDA, NVDA, null, now)).toBe("refresh");
  });
});
