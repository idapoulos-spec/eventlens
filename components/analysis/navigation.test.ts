import { describe, expect, it } from "vitest";
import { analysisFromSearch, analysisHref, currentAnalysisHref, REANALYZE_AFTER_MS, sameAnalysis, submitAction } from "./navigation";

const NVDA = { stock: "NVDA", kalshi: "KXFEDDECISION-26OCT-H25" };
const SPY = { stock: "SPY", kalshi: "KXRECSSNBER-27" };

describe("analysisHref", () => {
  it("puts both tickers in the home page's query string", () => {
    expect(analysisHref(NVDA)).toBe("/?stock=NVDA&kalshi=KXFEDDECISION-26OCT-H25");
  });

  it("encodes characters that are special in a query string", () => {
    expect(analysisHref({ stock: "BRK.B", kalshi: "KXA&B=C" })).toBe("/?stock=BRK.B&kalshi=KXA%26B%3DC");
  });

  it("adds where Research opens only when given (a scan result's link)", () => {
    expect(analysisHref(NVDA, { window: 365, resolution: "daily" })).toBe("/?stock=NVDA&kalshi=KXFEDDECISION-26OCT-H25&window=365&res=daily");
    expect(analysisHref(NVDA, { window: "all", resolution: null })).toBe("/?stock=NVDA&kalshi=KXFEDDECISION-26OCT-H25&window=all");
    expect(analysisHref(NVDA, { window: null, resolution: null })).toBe(analysisHref(NVDA));
  });
});

describe("analysisHref with every setting", () => {
  const AS_OF = Date.UTC(2026, 9, 7, 18, 2, 10, 345);

  it("writes each one that isn't its default, and the as-of time as UTC", () => {
    expect(analysisHref(NVDA, { window: 30, resolution: "daily", returns: "raw", benchmark: "QQQ", jump: 0.5, asOf: AS_OF })).toBe(
      "/?stock=NVDA&kalshi=KXFEDDECISION-26OCT-H25&window=30&res=daily&returns=raw&bench=QQQ&jump=0.5&asof=2026-10-07T18%3A02%3A10.345Z",
    );
    expect(analysisHref(NVDA, { window: null, resolution: null, returns: null, benchmark: null, jump: null, asOf: null })).toBe(analysisHref(NVDA));
  });

  it("reads back the same through the page's own parser", () => {
    const href = analysisHref(NVDA, { window: "all", resolution: "hourly", benchmark: "BRK.B", jump: 10, asOf: Date.UTC(2026, 9, 7, 18) });
    expect(href).toContain("asof=2026-10-07T18%3A00Z");
    expect(currentAnalysisHref(href.slice(1), Date.UTC(2026, 9, 25))).toBe(href);
  });
});

describe("currentAnalysisHref", () => {
  const now = Date.UTC(2026, 9, 25);

  it("rebuilds the link from what the page reads, dropping anything else", () => {
    expect(currentAnalysisHref("?stock=nvda&kalshi=KXFEDDECISION-26OCT-H25&utm_source=x&window=7&bench=", now)).toBe(
      "/?stock=NVDA&kalshi=KXFEDDECISION-26OCT-H25&window=7",
    );
  });

  it("is null without a valid analysis, or with an as-of time the page would reject", () => {
    expect(currentAnalysisHref("?stock=NVDA", now)).toBeNull();
    expect(currentAnalysisHref("?stock=NVDA&kalshi=KXFEDDECISION-26OCT-H25&asof=yesterday", now)).toBeNull();
    expect(analysisFromSearch("?stock=NVDA&kalshi=KXFEDDECISION-26OCT-H25")).toEqual(NVDA);
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
