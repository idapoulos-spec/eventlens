import "server-only";

import { LIVE } from "@/lib/fetch-cache";
import { isTimeout } from "@/lib/request-timeout";
import { fail, ok, type DataError, type Result } from "@/lib/result";
import type { StockSearchResult } from "@/lib/search/types";
import { buildSymbolIndex, searchSymbols, type SymbolIndex } from "./symbols";
import { getApiKey, twelveGet, TwelveDataError } from "./twelve-data";
import type { RawSymbolList } from "./types";

/** Results per search. */
export const STOCK_SEARCH_LIMIT = 10;

/** Twelve Data updates its symbol lists daily. */
export const SYMBOL_LIST_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * After a failed download, searches get the same error for this long instead of downloading
 * again: a download that timed out may still have spent its credits.
 */
export const SYMBOL_LIST_RETRY_MS = 5 * 60 * 1000;

/**
 * The lists are 3 to 6 MB each, and Twelve Data took anywhere from 1.3 to 25 seconds to send
 * one (measured 2026-09-29), so they get far longer than the usual timeout.
 * app/api/search/stocks/route.ts allows the route to run this long.
 */
export const SYMBOL_LIST_TIMEOUT_MS = 45_000;

/** Both lists are for the US only; Twelve Data filters them by country name. */
const US = { country: "United States" };

// The index is kept in this server instance's memory. The lists are too big for Next.js's data
// cache (at most 2 MB an entry), so each instance downloads them once a day, when it first
// searches: 2 API credits. Every search after that runs on the index and costs none.
let loaded: { index: SymbolIndex; at: number } | null = null;
let failed: { error: DataError; at: number } | null = null;
let loading: Promise<Result<SymbolIndex>> | null = null;

function describeListError(err: unknown, apiKey: string): Result<never> {
  const status = err instanceof TwelveDataError ? err.code : "network";
  const detail = err instanceof Error ? err.message : String(err);
  console.error(`[twelve-data] symbol lists: ${status} ${detail.replaceAll(apiKey, "[redacted]")}`);

  const fallback = "You can still enter a ticker.";
  if (isTimeout(err)) {
    return fail("timeout", `Twelve Data didn't respond in time, so stock search is unavailable. ${fallback}`);
  }
  if (!(err instanceof TwelveDataError)) {
    return fail("unavailable", `Could not reach Twelve Data, so stock search is unavailable. ${fallback}`);
  }
  if (err.code === 401) {
    return fail("auth", `Twelve Data rejected this app's API key, so stock search is unavailable. ${fallback}`);
  }
  if (err.code === 429) {
    return fail("rate_limited", `Twelve Data rate limit reached, so stock search is unavailable for a few minutes. ${fallback}`);
  }
  return fail("upstream", `Twelve Data returned an error, so stock search is unavailable. ${fallback}`);
}

async function downloadIndex(): Promise<Result<SymbolIndex>> {
  const apiKey = getApiKey();
  if (!apiKey) {
    return fail(
      "missing_key",
      "Stock search isn't available because this site hasn't been set up with a market-data API key. You can still enter a ticker.",
    );
  }
  try {
    const [stocks, etfs] = await Promise.all(
      ["/stocks", "/etfs"].map((path) => twelveGet<RawSymbolList>(path, US, apiKey, LIVE, SYMBOL_LIST_TIMEOUT_MS)),
    );
    if (!Array.isArray(stocks.data) || !Array.isArray(etfs.data)) {
      throw new TwelveDataError(502, "Symbol list response has no data array");
    }
    const index = buildSymbolIndex(stocks.data, etfs.data);
    if (index.length === 0) throw new TwelveDataError(502, "Symbol lists are empty");
    return ok(index);
  } catch (err) {
    return describeListError(err, apiKey);
  }
}

/** Today's index: from memory, or downloaded once however many searches are waiting for it. */
async function getSymbolIndex(): Promise<Result<SymbolIndex>> {
  const now = Date.now();
  if (loaded && now - loaded.at < SYMBOL_LIST_TTL_MS) return ok(loaded.index);
  // Keep answering from the previous day's lists while a new download can't be tried yet.
  if (failed && now - failed.at < SYMBOL_LIST_RETRY_MS) return loaded ? ok(loaded.index) : { ok: false, error: failed.error };

  loading ??= downloadIndex().then((result) => {
    loading = null;
    if (result.ok) {
      loaded = { index: result.data, at: Date.now() };
      failed = null;
      return result;
    }
    failed = { error: result.error, at: Date.now() };
    return loaded ? ok(loaded.index) : result;
  });
  return loading;
}

/**
 * US stocks and ETFs matching `query` by ticker or name, best first (see searchSymbols).
 * Searches an in-memory copy of Twelve Data's symbol lists, so typing doesn't spend API credits.
 */
export async function searchUsStocks(query: string, limit = STOCK_SEARCH_LIMIT): Promise<Result<StockSearchResult[]>> {
  const index = await getSymbolIndex();
  return index.ok ? ok(searchSymbols(index.data, query, limit)) : index;
}
