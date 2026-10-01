import "server-only";

import { impliedProbability } from "@/lib/analytics";
import { LIVE } from "@/lib/fetch-cache";
import { isTimeout } from "@/lib/request-timeout";
import { fail, ok, type DataError, type Result } from "@/lib/result";
import type { KalshiSearchResult } from "@/lib/search/types";
import { validateKalshiTicker } from "@/lib/validation";
import { KalshiHttpError, kalshiGet, toNumber } from "./client";
import { marketPhase } from "./status";
import type { RawEvent, RawEventsPage } from "./types";

// Kalshi's Trade API has no keyword search: /events and /markets only filter by ticker,
// status, and time. So search runs here, over an in-memory index of every open market in
// every open event (GET /events excludes multivariate combos). All searches on a server
// share one index, so Kalshi sees one rebuild every few minutes, however many people search.
//
// A page of 200 events with their markets can be 4 MB, well over the 2 MB that Next.js's
// data cache accepts, so pages are fetched uncached and only the compact index is kept.
// In September 2026 Kalshi listed about 12,000 open events with 114,000 open markets:
// 61 pages, which took about 15 seconds to load.

/** Events per page, Kalshi's maximum. */
const PAGE_SIZE = 200;
/** Stops a cursor that never ends, with room for Kalshi to list twice as many events. */
export const MAX_INDEX_PAGES = 150;
/**
 * Index pages are requested one after another, starting at least this far apart: at most
 * 4 a second, a fifth of Kalshi's basic budget of 20 reads a second, which the dashboard's
 * requests from this server share.
 */
export const MIN_REQUEST_INTERVAL_MS = 250;
/** An index this recent is used as is, so its probabilities are at most a few minutes old. */
export const INDEX_FRESH_MS = 3 * 60_000;
/** An older index is still served, while one refresh runs in the background, until it's this old. */
export const INDEX_MAX_AGE_MS = 15 * 60_000;
/** After a failed build, Kalshi isn't asked again for this long. Its 429s don't say how long to wait. */
export const FAILED_BUILD_BACKOFF_SEC = 30;
export const MAX_SEARCH_RESULTS = 20;
const MAX_QUERY_WORDS = 12;

/** Each field's words as " word word ", so `includes(" pre")` finds a word that starts with "pre". */
interface Words {
  market: string;
  ticker: string;
  event: string;
  category: string;
}

interface Entry {
  result: KalshiSearchResult;
  /** To leave out markets that closed since the index was built. */
  closeMs: number | null;
  volume24h: number;
  openInterest: number;
  words: Words;
}

interface SearchIndex {
  entries: Entry[];
  /** When the build started: no probability in the index is older. */
  builtAt: number;
}

// A word's weight in the field it matches best. A whole word counts double a prefix.
const FIELD_WEIGHTS: [keyof Words, number][] = [
  ["market", 3],
  ["ticker", 3],
  ["event", 2],
  ["category", 1],
];

const WORD = /[\p{L}\p{N}]+(?:\.\p{N}+)*/gu;
const THOUSANDS_SEPARATOR = /(?<=\p{N}),(?=\p{N}{3}(?!\p{N}))/gu;

/**
 * Lowercase words without accents, keeping decimals and dropping thousands separators, e.g.
 * "Mugur Isărescu" → ["mugur", "isarescu"] and "$33,000 or 4.25%?" → ["33000", "or", "4.25"].
 */
export function searchWords(text: string): string[] {
  return (
    text.normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase().replace(THOUSANDS_SEPARATOR, "").match(WORD) ?? []
  );
}

const spaced = (text: string) => ` ${searchWords(text).join(" ")} `;

function toEntries(event: RawEvent): Entry[] {
  const markets = (event.markets ?? []).filter(
    (m) => marketPhase(m.status ?? "unknown") === "open" && validateKalshiTicker(m.ticker).ok,
  );
  const eventTitle = event.title || event.event_ticker;
  const category = event.category ?? "";
  const eventWords = spaced(`${eventTitle} ${event.sub_title ?? ""}`);
  const categoryWords = spaced(category);

  // Some events give every market the same title (e.g. "Who will the next Pope be?") and
  // tell them apart only by the YES side, so those markets get it as their subtitle.
  const titleCounts = new Map<string, number>();
  for (const m of markets) {
    const title = m.title || m.ticker;
    titleCounts.set(title, (titleCounts.get(title) ?? 0) + 1);
  }

  return markets.map((m) => {
    const title = m.title || m.ticker;
    const yes = m.yes_sub_title || m.subtitle || "";
    const closeMs = m.close_time ? Date.parse(m.close_time) : NaN;
    return {
      result: {
        ticker: m.ticker,
        title,
        ...(yes && (titleCounts.get(title) ?? 0) > 1 ? { subtitle: yes } : {}),
        eventTitle,
        category,
        status: "open",
        closeTime: m.close_time ?? null,
        probability: impliedProbability(
          toNumber(m.yes_bid_dollars),
          toNumber(m.yes_ask_dollars),
          toNumber(m.last_price_dollars),
        ).value,
      },
      closeMs: Number.isFinite(closeMs) ? closeMs : null,
      volume24h: toNumber(m.volume_24h_fp) ?? 0,
      openInterest: toNumber(m.open_interest_fp) ?? 0,
      words: {
        market: spaced(`${title} ${yes}`),
        ticker: spaced(m.ticker), // Starts with the event ticker.
        event: eventWords,
        category: categoryWords,
      },
    };
  });
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

async function fetchEntries(): Promise<Entry[]> {
  const entries: Entry[] = [];
  // Events that open or close mid-build shift later pages, so one can show up twice.
  const seen = new Set<string>();
  let cursor = "";
  let lastRequestAt = -Infinity;
  for (let page = 0; page < MAX_INDEX_PAGES; page++) {
    const wait = lastRequestAt + MIN_REQUEST_INTERVAL_MS - Date.now();
    if (wait > 0) await sleep(wait);
    lastRequestAt = Date.now();

    const query = new URLSearchParams({ status: "open", with_nested_markets: "true", limit: String(PAGE_SIZE) });
    if (cursor) query.set("cursor", cursor);
    const data = await kalshiGet<RawEventsPage>(`/events?${query}`, LIVE);
    for (const event of data.events ?? []) {
      if (seen.has(event.event_ticker)) continue;
      seen.add(event.event_ticker);
      entries.push(...toEntries(event));
    }

    cursor = data.cursor ?? "";
    if (!cursor || !data.events?.length) return entries;
  }
  console.warn(`Kalshi search stopped after ${MAX_INDEX_PAGES} pages of open events; later events can't be found.`);
  return entries;
}

/** Fixed, user-facing wording for a failed index build. */
function describeFailure(err: unknown): DataError {
  if (err instanceof KalshiHttpError && err.status === 429) {
    return { code: "upstream_rate_limited", message: "Kalshi is limiting requests right now. Try searching again in a minute." };
  }
  if (isTimeout(err)) {
    return { code: "upstream_timeout", message: "Kalshi didn't respond in time. Try searching again shortly." };
  }
  return { code: "upstream_unavailable", message: "Couldn't load Kalshi markets. Try searching again shortly." };
}

// Per server process, like the rate limiters.
let index: SearchIndex | null = null;
let build: Promise<Result<SearchIndex>> | null = null;
let lastFailure: { error: DataError; at: number } | null = null;

/** Starts a build unless one is running. Never rejects. */
function refresh(): Promise<Result<SearchIndex>> {
  if (!build) {
    const startedAt = Date.now();
    build = fetchEntries()
      .then((entries) => {
        index = { entries, builtAt: startedAt };
        lastFailure = null;
        return ok(index);
      })
      .catch((err: unknown) => {
        lastFailure = { error: describeFailure(err), at: Date.now() };
        return fail<SearchIndex>(lastFailure.error.code, lastFailure.error.message);
      })
      .finally(() => {
        build = null;
      });
  }
  return build;
}

/** The index to search: a recent one right away, or else the result of building one. */
async function currentIndex(): Promise<Result<SearchIndex>> {
  const now = Date.now();
  const age = index ? now - index.builtAt : Infinity;
  if (index && age < INDEX_FRESH_MS) return ok(index);
  const usable = index && age < INDEX_MAX_AGE_MS ? index : null;

  // Right after a failed build, don't ask Kalshi again: serve what's left, or the failure.
  if (lastFailure && now - lastFailure.at < FAILED_BUILD_BACKOFF_SEC * 1000) {
    return usable ? ok(usable) : { ok: false, error: lastFailure.error };
  }
  const pending = refresh();
  return usable ? ok(usable) : pending;
}

/** Match strength across all of `words`, or 0 if some word starts no word in the entry. */
function score(entry: Entry, probes: { prefix: string; whole: string }[], upperQuery: string): number {
  let total = 0;
  for (const { prefix, whole } of probes) {
    let best = 0;
    for (const [field, weight] of FIELD_WEIGHTS) {
      const text = entry.words[field];
      if (text.includes(whole)) best = Math.max(best, 2 * weight);
      else if (text.includes(prefix)) best = Math.max(best, weight);
    }
    if (best === 0) return 0;
    total += best;
  }
  // A pasted ticker comes first, then the markets it's the start of (e.g. an event ticker).
  const { ticker } = entry.result;
  return total + (ticker === upperQuery ? 100 : ticker.startsWith(upperQuery) ? 10 : 0);
}

function rank(entries: Entry[], query: string, now: number): KalshiSearchResult[] {
  const words = [...new Set(searchWords(query))].slice(0, MAX_QUERY_WORDS);
  if (!words.length) return [];
  const probes = words.map((w) => ({ prefix: ` ${w}`, whole: ` ${w} ` }));
  const upperQuery = query.toUpperCase();

  const matches: { entry: Entry; score: number }[] = [];
  for (const entry of entries) {
    if (entry.closeMs !== null && entry.closeMs <= now) continue;
    const s = score(entry, probes, upperQuery);
    if (s > 0) matches.push({ entry, score: s });
  }
  // Among equal matches (e.g. every strike of one event), the most traded come first.
  matches.sort(
    (a, b) =>
      b.score - a.score ||
      b.entry.volume24h - a.entry.volume24h ||
      b.entry.openInterest - a.entry.openInterest ||
      (a.entry.closeMs ?? Infinity) - (b.entry.closeMs ?? Infinity) ||
      (a.entry.result.ticker < b.entry.result.ticker ? -1 : 1),
  );
  return matches.slice(0, MAX_SEARCH_RESULTS).map((m) => m.entry.result);
}

/**
 * Open Kalshi markets whose market, event, or category words start with every word of
 * `query` (so "fed hik" finds "Will the Fed hike…"), or whose ticker starts with it; best
 * match first. Probabilities are as of the index build, so at most a few minutes old.
 */
export async function searchKalshiMarkets(query: string): Promise<Result<KalshiSearchResult[]>> {
  const current = await currentIndex();
  if (!current.ok) return current;
  return ok(rank(current.data.entries, query, Date.now()));
}

/** The index refresh in progress, if any, for a route to finish after responding (see `after`). */
export function pendingKalshiIndexRefresh(): Promise<unknown> | undefined {
  return build ?? undefined;
}
