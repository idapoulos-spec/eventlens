import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { StockSearchResult } from "@/lib/search/types";
import { StockSearch } from "./StockSearch";
import { StockSearchList } from "./StockSearchList";
import { initialStockSearchState, SLOW_SEARCH_MESSAGE, type StockSearchState } from "./StockSearchState";

// Static markup only: vitest runs in Node without a DOM, so interaction is covered by the
// reducer's tests (StockSearchState.test.ts).

const NVDA: StockSearchResult = { symbol: "NVDA", name: "NVIDIA Corporation", exchange: "NASDAQ", type: "Common Stock" };
const NVDL: StockSearchResult = { symbol: "NVDL", name: "GraniteShares 2x Long NVDA Daily ETF", exchange: "NASDAQ", type: "ETF" };

const noop = () => {};

function field(props: { value?: string; invalid?: boolean } = {}) {
  const html = renderToStaticMarkup(<StockSearch value={props.value ?? ""} onSelect={noop} invalid={props.invalid} />);
  return new Markup(html);
}

function list(state: Partial<StockSearchState>) {
  const html = renderToStaticMarkup(
    <StockSearchList state={{ ...initialStockSearchState, open: true, ...state }} listboxId="r" onPick={noop} onHover={noop} />,
  );
  return new Markup(html);
}

/** Just enough markup inspection for these tests. */
class Markup {
  constructor(readonly html: string) {}
  /** Attributes of the first element with this tag. */
  attrs(tag: string): Record<string, string> {
    const match = this.html.match(new RegExp(`<${tag}\\b([^>]*)>`));
    if (!match) throw new Error(`No <${tag}> in ${this.html}`);
    return Object.fromEntries([...match[1].matchAll(/([\w-]+)(?:="([^"]*)")?/g)].map((m) => [m[1], m[2] ?? ""]));
  }
  count(pattern: string) {
    return this.html.split(pattern).length - 1;
  }
  get text() {
    return this.html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
  }
}

describe("StockSearch", () => {
  it("renders a labeled, collapsed combobox that submits as ?stock=", () => {
    const html = field({ value: "NVDA" });
    const input = html.attrs("input");
    expect(input).toMatchObject({ name: "stock", value: "NVDA", role: "combobox", "aria-autocomplete": "list", "aria-expanded": "false" });
    expect(html.attrs("label").for).toBe(input.id);
    expect(input).not.toHaveProperty("aria-controls");
    expect(input).not.toHaveProperty("aria-activedescendant");
    // Long enough for company names, not only tickers.
    expect(input.maxLength).toBe("100");
  });

  it("marks the field invalid only when TickerForm rejects it", () => {
    expect(field().attrs("input")).not.toHaveProperty("aria-invalid");
    expect(field({ invalid: true }).attrs("input")["aria-invalid"]).toBe("true");
  });

  it("has a polite live region for result counts and errors", () => {
    expect(field().attrs("p")).toMatchObject({ "aria-live": "polite", class: "sr-only" });
  });
});

describe("StockSearchList", () => {
  it("lists results as options, with the highlighted one selected", () => {
    const html = list({ query: "nv", status: "done", results: [NVDA, NVDL], active: 1 });
    expect(html.attrs("ul")).toMatchObject({ id: "r", role: "listbox" });
    expect(html.count('role="option"')).toBe(2);
    expect(html.html).toContain('id="r-0" role="option" aria-selected="false"');
    expect(html.html).toContain('id="r-1" role="option" aria-selected="true"');
    expect(html.text).toContain("NVDA NVIDIA Corporation NASDAQ · Common Stock");
    expect(html.text).toContain("NVDL GraniteShares 2x Long NVDA Daily ETF NASDAQ · ETF");
  });

  it("shows that a search is running, keeping the previous results dimmed", () => {
    expect(list({ query: "nv", status: "loading" }).text).toBe("Searching…");
    expect(list({ query: "nv", status: "loading", slow: true }).text).toBe(SLOW_SEARCH_MESSAGE);

    const stale = list({ query: "nvd", status: "loading", results: [NVDA] });
    expect(stale.attrs("ul")["aria-busy"]).toBe("true");
    expect(stale.attrs("ul").class).toContain("opacity-50");
    expect(stale.text).toContain("Searching…");
  });

  it("says when nothing matches", () => {
    const html = list({ query: "zzz", status: "done" });
    expect(html.text).toBe("No US stocks or ETFs match “zzz”.");
    expect(html.count("<ul")).toBe(0);
  });

  it("shows why search failed", () => {
    const html = list({ query: "nv", status: "error", error: "Twelve Data rate limit reached. You can still enter a ticker." });
    expect(html.text).toBe("Twelve Data rate limit reached. You can still enter a ticker.");
  });
});
