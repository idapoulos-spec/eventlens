import { describe, expect, it } from "vitest";
import { buildSymbolIndex, searchSymbols } from "./symbols";
import type { RawSymbol } from "./types";

const stock = (symbol: string, name: string, exchange = "NASDAQ", type = "Common Stock"): RawSymbol => ({
  symbol,
  name,
  exchange,
  type,
});
const etf = (symbol: string, name: string, exchange = "NYSE"): RawSymbol => ({ symbol, name, exchange });

// Shapes and names as Twelve Data's /stocks and /etfs return them.
const STOCKS = [
  stock("AAPL", "Apple Inc."),
  stock("APLE", "Apple Hospitality REIT, Inc.", "NYSE", "REIT"),
  stock("APRU", "Apple Rush Co. Inc.", "OTC"),
  stock("BRK.A", "Berkshire Hathaway Inc. Class A", "NYSE"),
  stock("BRK.B", "Berkshire Hathaway Inc. Class B", "NYSE"),
  stock("BRKC", "Brick Capital Inc.", "NYSE"),
  stock("BAC", "Bank of America Corporation", "NYSE"),
  stock("BAC.PR.S", "Bank of America Corporation Pref. Series S", "NYSE", "Preferred Stock"),
  stock("KO", "The Coca-Cola Company", "NYSE"),
  stock("COKE", "Coca-Cola Consolidated Inc."),
  stock("T", "AT&T Inc.", "NYSE"),
  stock("ATTO", "Attovia Therapeutics Inc.", "NYSE"),
  stock("JPM", "JPMorgan Chase & Co.", "NYSE"),
  stock("MSFT", "Microsoft Corporation"),
  stock("NSRGY", "Nestlé S.A. Sponsored ADR", "OTC", "American Depositary Receipt"),
  stock("NVDA", "NVIDIA Corporation"),
  stock("NVDAW", "NVIDIA Warrant Trust", "NASDAQ", "Warrant"),
  stock("NVDX", "NVX Holdings", "OTC"),
  stock("SOFT", "Softech Inc.", "OTC"),
  // Listed on IEX as well as NASDAQ.
  stock("KEEL", "Keel Infrastructure Corp.", "IEX"),
  stock("KEEL", "Keel Infrastructure Corp.", "NASDAQ"),
  // An OTC stock whose symbol is also an ETF's.
  stock("BRTR", "Barrister Global Services Network, Inc.", "OTC"),
  stock("!otc/FEED", "Feed", "OTC"),
  stock("NONAME", "  "),
];

const ETFS = [
  etf("SPY", "State Street SPDR S&P 500 ETF Trust"),
  etf("SPYX", "SPDR S&P 500 Fossil Fuel Reserves Free ETF"),
  etf("VOO", "Vanguard S&P 500 ETF"),
  etf("NVDL", "GraniteShares 2x Long NVDA Daily ETF", "NASDAQ"),
  etf("BRTR", "iShares Total Return Active ETF", "NASDAQ"),
  // Mutual fund and unit investment trust quoted through Nasdaq's fund network.
  etf("VFIAX", "Vanguard 500 Index Fund Admiral Shares", "NASDAQ"),
  etf("FDREEX", "FT Series 12315 Unit Investment Trust", "NASDAQ"),
];

const index = buildSymbolIndex(STOCKS, ETFS);
const symbols = (query: string, limit = 10) => searchSymbols(index, query, limit).map((r) => r.symbol);

describe("buildSymbolIndex", () => {
  it("keeps stocks and ETFs with their provider type, labeling ETF-list entries ETF", () => {
    expect(searchSymbols(index, "AAPL", 1)).toEqual([{ symbol: "AAPL", name: "Apple Inc.", exchange: "NASDAQ", type: "Common Stock" }]);
    expect(searchSymbols(index, "SPY", 1)).toEqual([
      { symbol: "SPY", name: "State Street SPDR S&P 500 ETF Trust", exchange: "NYSE", type: "ETF" },
    ]);
  });

  it("leaves out symbols the dashboard can't analyze", () => {
    const all = index.map((e) => e.result.symbol);
    expect(all).not.toContain("BAC.PR.S");
    expect(all).not.toContain("!otc/FEED");
  });

  it("leaves out mutual funds and unit trusts from the ETF list, but not 4-letter ETFs ending in X", () => {
    const all = index.map((e) => e.result.symbol);
    expect(all).not.toContain("VFIAX");
    expect(all).not.toContain("FDREEX");
    expect(all).toContain("SPYX");
  });

  it("keeps one entry per symbol, preferring NASDAQ or NYSE over IEX, and IEX over OTC", () => {
    expect(index.filter((e) => e.result.symbol === "KEEL").map((e) => e.result.exchange)).toEqual(["NASDAQ"]);
    expect(index.filter((e) => e.result.symbol === "BRTR").map((e) => e.result.name)).toEqual(["iShares Total Return Active ETF"]);
  });

  it("uses the symbol as the name when the provider has none", () => {
    expect(searchSymbols(index, "NONAME", 1)[0].name).toBe("NONAME");
  });
});

describe("searchSymbols", () => {
  it("puts an exact ticker first, ignoring case, even an OTC one", () => {
    expect(symbols("nvda")[0]).toBe("NVDA");
    expect(symbols("soft")[0]).toBe("SOFT");
  });

  it("finds class shares however the ticker is punctuated", () => {
    for (const query of ["BRK.B", "brk-b", "brk/b", "brk b", "BRKB"]) expect(symbols(query)[0]).toBe("BRK.B");
  });

  it("matches ticker prefixes, class shares before longer tickers", () => {
    expect(symbols("brk")).toEqual(["BRK.A", "BRK.B", "BRKC"]);
  });

  it("finds companies by name, listed common stock before REITs' longer names and OTC listings", () => {
    expect(symbols("apple")).toEqual(["AAPL", "APLE", "APRU"]);
    expect(symbols("  Apple   INC ")).toEqual(["AAPL", "APLE", "APRU"]);
  });

  it("ranks common stock and ETFs before warrants, and those before OTC listings", () => {
    expect(symbols("nvd")).toEqual(["NVDA", "NVDL", "NVDAW", "NVDX"]);
  });

  it("ignores a leading 'The' and punctuation in names", () => {
    expect(symbols("coca cola")).toEqual(["KO", "COKE"]);
    expect(symbols("the coca-cola")).toEqual(["KO", "COKE"]);
  });

  it("treats text that can't be a ticker as a name", () => {
    expect(symbols("at&t")[0]).toBe("T");
    expect(symbols("att")).toEqual(["ATTO", "T"]);
  });

  it("matches each query word to a different word of the name, in any order", () => {
    expect(symbols("berkshire b")).toEqual(["BRK.B"]);
    expect(symbols("class a berkshire")).toEqual(["BRK.A"]);
    expect(symbols("america bank")).toEqual(["BAC"]);
  });

  it("ignores accents and spaces inside names", () => {
    expect(symbols("nestle")).toEqual(["NSRGY"]);
    expect(symbols("jp morgan")).toEqual(["JPM"]);
  });

  it("matches the middle of a word after better matches", () => {
    expect(symbols("soft")).toEqual(["SOFT", "MSFT"]);
    // Two letters would match too much.
    expect(symbols("os")).toEqual([]);
  });

  it("breaks ties between name matches by name length, and returns at most `limit` results", () => {
    expect(symbols("s&p 500")).toEqual(["VOO", "SPY", "SPYX"]);
    expect(symbols("s&p 500", 2)).toEqual(["VOO", "SPY"]);
  });

  it("returns nothing for text with no letters or digits, or no match", () => {
    expect(symbols("&&")).toEqual([]);
    expect(symbols("zzzz")).toEqual([]);
  });
});
