// Stock search over Twelve Data's lists of US stocks and ETFs. Pure: symbol-search.ts downloads
// the lists and keeps the index in memory.

import type { StockSearchResult } from "@/lib/search/types";
import { validateStockTicker } from "@/lib/validation";
import type { RawSymbol } from "./types";

/**
 * Where a symbol's listing ranks. IEX lists few companies of its own and mostly duplicates
 * NASDAQ and NYSE listings; OTC and anything else rank last.
 */
const EXCHANGE_RANK: Record<string, number> = { NASDAQ: 0, NYSE: 0, CBOE: 0, IEX: 1 };
const OTHER_EXCHANGE_RANK = 2;

/** Securities that sit alongside a company's shares; they rank after common stock and ETFs. */
const SECONDARY_TYPES = new Set(["Preferred Stock", "Warrant", "Right", "Unit"]);

/**
 * Twelve Data's ETF list also carries about 5,000 mutual funds and unit investment trusts
 * quoted through Nasdaq's fund network, with 5- and 6-letter symbols ending in X. They
 * aren't exchange-traded and have no intraday prices, so they're left out.
 */
const FUND_SYMBOL = /^[A-Z]{4,5}X$/;

export interface IndexedSymbol {
  result: StockSearchResult;
  /** Symbol without punctuation, so "BRK B", "BRK-B", and "BRKB" all find BRK.B. */
  compactSymbol: string;
  /** Lowercase words of the name without accents, punctuation, or a leading "the", e.g. "coca cola company". */
  phrase: string;
  /** The phrase without spaces, so "jp morgan" finds "JPMorgan". */
  compactName: string;
  words: string[];
  /** 0 for common stock and ETFs listed on NASDAQ, NYSE, or Cboe; higher ranks sort later. */
  rank: number;
}

export type SymbolIndex = readonly IndexedSymbol[];

function words(text: string): string[] {
  const all = text
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
  // "The Coca-Cola Company" should start with "coca cola".
  return all[0] === "the" ? all.slice(1) : all;
}

const compact = (text: string) => text.replace(/[^A-Za-z0-9]/g, "").toUpperCase();

/** Characters a typed ticker can contain ("BRK.B", "BRK-B", "BRK/B", "BRK B"). */
const TICKER_TEXT = /^[A-Za-z0-9./ -]+$/;

function rank(exchange: string, type: string): number {
  return (EXCHANGE_RANK[exchange] ?? OTHER_EXCHANGE_RANK) * 2 + (SECONDARY_TYPES.has(type) ? 1 : 0);
}

/**
 * Index for searchSymbols. Symbols the dashboard can't analyze (preferred shares such as
 * "BAC.PR.S" fail validateStockTicker) are left out. A symbol listed on more than one venue
 * keeps its best-ranked listing (NASDAQ or NYSE over IEX over OTC), since the dashboard looks
 * stocks up by symbol alone.
 */
export function buildSymbolIndex(stocks: readonly RawSymbol[], etfs: readonly RawSymbol[]): SymbolIndex {
  const bySymbol = new Map<string, IndexedSymbol>();

  function add(raw: RawSymbol, type: string) {
    const ticker = validateStockTicker(raw.symbol);
    if (!ticker.ok) return;
    const symbol = ticker.value;
    const exchange = raw.exchange?.trim() ?? "";
    const name = raw.name?.trim() || symbol;
    const nameWords = words(name);
    const entry: IndexedSymbol = {
      result: { symbol, name, exchange, type },
      compactSymbol: compact(symbol),
      phrase: nameWords.join(" "),
      compactName: nameWords.join(""),
      words: nameWords,
      rank: rank(exchange, type),
    };
    const existing = bySymbol.get(symbol);
    if (!existing || entry.rank < existing.rank) bySymbol.set(symbol, entry);
  }

  for (const raw of stocks) add(raw, raw.type?.trim() || "Stock");
  for (const raw of etfs) {
    if (!FUND_SYMBOL.test(raw.symbol)) add(raw, "ETF");
  }
  return [...bySymbol.values()];
}

// How a result matched the query, best first.
const EXACT_SYMBOL = 0;
const COMPACT_SYMBOL = 1;
const SYMBOL_PREFIX = 2;
const NAME_PREFIX = 3;
const NAME_WORDS = 4;
const NAME_SUBSTRING = 5;

interface Query {
  symbol: string;
  compactSymbol: string;
  /** Longest first, see matchesDistinctWords. */
  tokens: string[];
  phrase: string;
  compactPhrase: string;
}

/**
 * Whether each token starts a different word of the name, in any order: "berkshire b" finds
 * "Berkshire Hathaway Inc. Class B" but not "Berkshire Hathaway Inc. Class A". Longer tokens
 * claim their word first, and a token takes a word it equals before one it only starts.
 */
function matchesDistinctWords(tokens: readonly string[], nameWords: readonly string[]): boolean {
  const used = new Set<number>();
  return tokens.every((token) => {
    let index = nameWords.findIndex((w, i) => !used.has(i) && w === token);
    if (index < 0) index = nameWords.findIndex((w, i) => !used.has(i) && w.startsWith(token));
    used.add(index);
    return index >= 0;
  });
}

function matchTier(entry: IndexedSymbol, q: Query): number | null {
  if (q.compactSymbol) {
    if (entry.result.symbol === q.symbol) return EXACT_SYMBOL;
    if (entry.compactSymbol === q.compactSymbol) return COMPACT_SYMBOL;
    if (entry.compactSymbol.startsWith(q.compactSymbol)) return SYMBOL_PREFIX;
  }
  if (q.tokens.length === 0) return null;
  if (entry.phrase.startsWith(q.phrase) || entry.compactName.startsWith(q.compactPhrase)) return NAME_PREFIX;
  if (matchesDistinctWords(q.tokens, entry.words)) return NAME_WORDS;
  // Part of a word, e.g. "soft" in "Microsoft". Shorter fragments match too much to be useful.
  if (q.compactPhrase.length >= 3 && entry.compactName.includes(q.compactPhrase)) return NAME_SUBSTRING;
  return null;
}

/**
 * Up to `limit` entries matching `query` by ticker or company name, best first. Exact ticker
 * matches come first; after them, common stock and ETFs on the main exchanges come before
 * secondary securities and OTC listings, then better matches before weaker ones. Ties go to
 * shorter names for name matches (the provider's list has no popularity data, and "Apple
 * Inc." is a closer match for "apple" than "Apple Hospitality REIT, Inc."), then to shorter
 * tickers, ignoring punctuation (BRK.A before BRKC). Case, accents, and punctuation are ignored.
 */
export function searchSymbols(index: SymbolIndex, query: string, limit: number): StockSearchResult[] {
  const text = query.trim();
  const tokens = words(text);
  // Only text that could be a ticker is matched against tickers: "at&t" is a name, not "ATT".
  const tickerText = TICKER_TEXT.test(text);
  const q: Query = {
    symbol: tickerText ? text.toUpperCase() : "",
    compactSymbol: tickerText ? compact(text) : "",
    tokens: [...tokens].sort((a, b) => b.length - a.length),
    phrase: tokens.join(" "),
    compactPhrase: tokens.join(""),
  };
  if (!q.compactSymbol && tokens.length === 0) return [];

  const matches: { entry: IndexedSymbol; tier: number }[] = [];
  for (const entry of index) {
    const tier = matchTier(entry, q);
    if (tier !== null) matches.push({ entry, tier });
  }

  const exact = (tier: number) => (tier <= COMPACT_SYMBOL ? tier : COMPACT_SYMBOL + 1);
  matches.sort(
    (a, b) =>
      exact(a.tier) - exact(b.tier) ||
      a.entry.rank - b.entry.rank ||
      a.tier - b.tier ||
      (a.tier >= NAME_PREFIX ? a.entry.words.length - b.entry.words.length : 0) ||
      a.entry.compactSymbol.length - b.entry.compactSymbol.length ||
      // Symbols are unique, and "." and "-" sort before letters, so BRK.A still comes before BRKC.
      (a.entry.result.symbol < b.entry.result.symbol ? -1 : 1),
  );
  return matches.slice(0, limit).map((m) => m.entry.result);
}
