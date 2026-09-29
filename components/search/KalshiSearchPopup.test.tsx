import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { KalshiSearchResult } from "@/lib/search/types";
import { initialSearchState, type SearchState } from "./KalshiSearchModel";
import { KalshiSearchPopup, searchAnnouncement } from "./KalshiSearchPopup";

const FED: KalshiSearchResult = {
  ticker: "KXFEDDECISION-26OCT-H25",
  title: "Will the Fed hike rates by 25bps in October 2026?",
  eventTitle: "Fed decision in October 2026",
  category: "Economics",
  status: "open",
  closeTime: "2026-10-28T18:00:00Z",
  probability: 0.04,
};
const POPE: KalshiSearchResult = {
  ticker: "KXNEWPOPE-70-LANT",
  title: "Who will the next Pope be? — Luis Antonio Tagle",
  eventTitle: "Who will the next Pope be?",
  category: "Elections",
  status: "open",
  closeTime: "2070-01-01T15:00:00Z",
  probability: null,
};

const state = (patch: Partial<SearchState>): SearchState => ({ ...initialSearchState, query: "fed", open: true, ...patch });

function render(s: SearchState) {
  return renderToStaticMarkup(
    <KalshiSearchPopup
      state={s}
      listboxId="lb"
      optionId={(i) => `opt-${i}`}
      onPick={() => {}}
      onHighlight={() => {}}
      onRetry={() => {}}
    />,
  );
}

beforeEach(() => {
  vi.useFakeTimers({ now: Date.UTC(2026, 8, 29, 16, 0), toFake: ["Date"] });
});

afterEach(() => {
  vi.useRealTimers();
});

describe("KalshiSearchPopup", () => {
  it("lists each market's question, event, category, close date, ticker, and chance", () => {
    const html = render(state({ status: "done", results: [FED, POPE], active: 1 }));
    expect(html).toContain('role="listbox" aria-label="Kalshi markets"');
    expect(html).toContain('id="opt-0" role="option" aria-selected="false"');
    expect(html).toContain('id="opt-1" role="option" aria-selected="true"');
    expect(html).toContain("Will the Fed hike rates by 25bps in October 2026?");
    expect(html).toContain("Fed decision in October 2026");
    expect(html).toContain("Economics · Closes Oct 28 · ");
    expect(html).toContain("KXFEDDECISION-26OCT-H25");
    expect(html).toContain("4%");
    expect(html).toContain("Closes Jan 1, 2070");
    expect(html).toContain("no quote");
    expect(html).toContain("a few minutes old");
  });

  it("is hidden while closed, keeping the listbox the input points at", () => {
    const html = render(state({ status: "done", results: [FED], open: false }));
    expect(html).toMatch(/^<div hidden=""/);
    expect(html).toContain('id="lb"');
  });

  it("says it's searching, and explains a slow first search", () => {
    expect(render(state({ status: "loading" }))).toContain("Searching Kalshi markets…");
    expect(render(state({ status: "loading", slow: true }))).toContain("The first search can take up to half a minute");
  });

  it("says when nothing matches", () => {
    const html = render(state({ status: "done", results: [] }));
    expect(html).toContain("No open markets match <span");
    expect(html).toContain("“fed”");
    expect(html).toContain('role="listbox" aria-label="Kalshi markets" hidden=""');
  });

  it("shows an error with a way to retry", () => {
    const html = render(state({ status: "error", error: "Kalshi didn't respond in time." }));
    expect(html).toContain("Kalshi didn&#x27;t respond in time.");
    expect(html).toContain(">Try again</button>");
  });
});

describe("searchAnnouncement", () => {
  it("announces the result count, no matches, and errors, but not a closed popup", () => {
    expect(searchAnnouncement(state({ status: "done", results: [FED, POPE] }))).toMatch(/^2 markets found/);
    expect(searchAnnouncement(state({ status: "done", results: [FED] }))).toMatch(/^1 market found/);
    expect(searchAnnouncement(state({ status: "done", results: [] }))).toBe("No open markets match fed.");
    expect(searchAnnouncement(state({ status: "error", error: "Down." }))).toBe("Down.");
    expect(searchAnnouncement(state({ status: "loading" }))).toBe("");
    expect(searchAnnouncement(state({ status: "done", results: [FED], open: false }))).toBe("");
  });
});
