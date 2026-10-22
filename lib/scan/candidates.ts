import "server-only";

import { MAX_SCAN_CANDIDATES } from "@/lib/analytics/scan";
import { findEvent } from "@/lib/expected/load";
import { supportedEvent } from "@/lib/expected/series";
import { LIVE } from "@/lib/fetch-cache";
import { findKalshiMarket } from "@/lib/history/market";
import { readStore, storeOn } from "@/lib/history/store";
import { describeKalshiError, kalshiGet, toNumber } from "@/lib/kalshi/client";
import type { RawEvent, RawEventsPage, RawMarket } from "@/lib/kalshi/types";
import { fail, ok, type Result } from "@/lib/result";
import { readStoredMarkets, readStoredTickers } from "./store";
import type { ScanCandidate } from "./types";

// A scan's candidates: one per event. A Fed decision event is tested on its expected value; an
// event with one market on that market; any other event with several outcomes on the outcome with
// the highest lifetime volume, picked here from the listing, before any stock data is loaded.

/** Pages of open events read for one series: 200 events each. */
const MAX_EVENT_PAGES = 5;
/** Tickers resolved at once for a custom list, so Kalshi sees a few requests at a time. */
const LOOKUP_CONCURRENCY = 4;

export interface CandidateList {
  candidates: ScanCandidate[];
  /** Tickers or events left out, and why. */
  skipped: { ticker: string; reason: string }[];
  /** More than MAX_SCAN_CANDIDATES were found; the first ones (by close) are kept. */
  truncated: boolean;
}

const time = (iso: string | null | undefined) => {
  const ms = iso ? Date.parse(iso) : NaN;
  return Number.isFinite(ms) ? ms : null;
};

/** A market's lifetime volume (contracts): `volume_fp`, or the older integer `volume`. */
function lifetimeVolume(m: RawMarket): number {
  return toNumber(m.volume_fp) ?? toNumber(m.volume) ?? 0;
}

/** The outcome with the highest lifetime volume; ties go to the first ticker. */
export function pickOutcome(markets: RawMarket[]): RawMarket {
  return [...markets].sort((a, b) => lifetimeVolume(b) - lifetimeVolume(a) || (a.ticker < b.ticker ? -1 : 1))[0];
}

/**
 * One event's candidate, from its markets as listed. Windows end where its page's would: an
 * event's at its first close, a market's at its close (with the store on; without it, now), once passed.
 */
export function eventCandidate(event: { ticker: string; series: string | null; title: string; markets: RawMarket[] }, stored: boolean, now: number, store = storeOn()): Result<ScanCandidate> {
  const { ticker, series, markets } = event;
  if (markets.length === 0) return fail("no_markets", "Kalshi lists no markets for it.");
  if (supportedEvent(ticker)) {
    const closes = markets.map((m) => time(m.close_time)).filter((t): t is number => t !== null);
    const opens = markets.map((m) => time(m.open_time)).filter((t): t is number => t !== null);
    const close = closes.length ? Math.min(...closes) : null;
    return ok({
      ticker,
      kind: "event",
      event: ticker,
      series,
      title: event.title,
      label: null,
      picked: null,
      end: close !== null && close <= now ? close : null,
      start: opens.length ? Math.min(...opens) : null,
      stored,
    });
  }
  const market = markets.length === 1 ? markets[0] : pickOutcome(markets);
  return ok(marketCandidate(market, { series, title: event.title, picked: markets.length > 1 ? { outcomes: markets.length } : null, stored }, now, store));
}

function marketCandidate(m: RawMarket, extra: Pick<ScanCandidate, "series" | "title" | "picked" | "stored">, now: number, store: boolean): ScanCandidate {
  const close = time(m.close_time);
  return {
    ticker: m.ticker,
    kind: "market",
    event: m.event_ticker,
    label: m.yes_sub_title || m.subtitle || null,
    end: store && close !== null && close <= now ? close : null,
    start: time(m.open_time),
    ...extra,
  };
}

/** Earliest window end first (open ones last), then ticker: a stable order fixed before any result. */
function ordered(list: CandidateList): CandidateList {
  const key = (c: ScanCandidate) => c.end ?? Infinity;
  const sorted = [...list.candidates].sort((a, b) => key(a) - key(b) || (a.ticker < b.ticker ? -1 : 1));
  return { ...list, candidates: sorted.slice(0, MAX_SCAN_CANDIDATES), truncated: list.truncated || sorted.length > MAX_SCAN_CANDIDATES };
}

/** Every stored event (of one series, or all), settled ones included. */
export async function storedCandidates(series: string | null, now = Date.now()): Promise<Result<CandidateList>> {
  if (!storeOn()) return fail("no_store", "This site has no data store, so there are no stored events to scan.");
  const rows = await readStore("stored events", (sql) => readStoredMarkets(sql, series));
  if (rows === null) return fail("unavailable", "The data store couldn't be read. Please try again shortly.");
  const byEvent = new Map<string, { series: string | null; markets: RawMarket[] }>();
  for (const r of rows) {
    const e = byEvent.get(r.event) ?? { series: r.series, markets: [] };
    e.markets.push(r.raw);
    byEvent.set(r.event, e);
  }
  const list: CandidateList = { candidates: [], skipped: [], truncated: false };
  for (const [ticker, e] of byEvent) {
    const c = eventCandidate({ ticker, series: e.series, title: e.markets[0]?.title ?? ticker, markets: e.markets }, true, now);
    if (c.ok) list.candidates.push(c.data);
    else list.skipped.push({ ticker, reason: c.error.message });
  }
  return ok(ordered(list));
}

/** A series' open events from Kalshi, and with `settled` its stored settled events too. */
export async function seriesCandidates(series: string, { settled }: { settled: boolean }, now = Date.now()): Promise<Result<CandidateList>> {
  const events: RawEvent[] = [];
  let cursor = "";
  for (let page = 0; page < MAX_EVENT_PAGES; page++) {
    const query = new URLSearchParams({ series_ticker: series, status: "open", with_nested_markets: "true", limit: "200", ...(cursor && { cursor }) });
    try {
      const data = await kalshiGet<RawEventsPage>(`/events?${query}`, LIVE);
      events.push(...(data.events ?? []));
      cursor = data.cursor ?? "";
    } catch (err) {
      return describeKalshiError(err, series);
    }
    if (!cursor) break;
  }
  const stored = (await readStore("stored tickers", (sql) => readStoredTickers(sql, events.map((e) => e.event_ticker)))) ?? new Set<string>();
  const list: CandidateList = { candidates: [], skipped: [], truncated: cursor !== "" };
  for (const e of events) {
    const c = eventCandidate({ ticker: e.event_ticker, series: e.series_ticker ?? series, title: e.title || e.event_ticker, markets: e.markets ?? [] }, stored.has(e.event_ticker), now);
    if (c.ok) list.candidates.push(c.data);
    else list.skipped.push({ ticker: e.event_ticker, reason: c.error.message });
  }
  if (settled && storeOn()) {
    const past = await storedCandidates(series, now);
    if (past.ok) {
      const have = new Set(list.candidates.map((c) => c.event));
      list.candidates.push(...past.data.candidates.filter((c) => c.end !== null && !have.has(c.event)));
    }
  }
  return ok(ordered(list));
}

/** The event with its markets, while the live endpoints list them. */
async function liveEvent(ticker: string): Promise<Result<RawEvent>> {
  try {
    const data = await kalshiGet<{ event: RawEvent; markets?: RawMarket[] }>(`/events/${encodeURIComponent(ticker)}?with_nested_markets=true`, LIVE);
    return ok({ ...data.event, markets: data.event.markets?.length ? data.event.markets : (data.markets ?? []) });
  } catch (err) {
    return describeKalshiError(err, ticker);
  }
}

/** One ticker: a Fed decision event, a market, or any other event (one of its markets). */
async function tickerCandidate(ticker: string, stored: boolean, now: number): Promise<Result<ScanCandidate>> {
  if (supportedEvent(ticker)) {
    const found = await findEvent(ticker);
    if (!found.ok) return found;
    const { title, markets } = found.data;
    return eventCandidate({ ticker, series: seriesOf(ticker), title, markets }, stored || found.data.stored.length > 0, now);
  }
  const market = await findKalshiMarket(ticker);
  if (market.ok) {
    const raw = market.data.market;
    return ok({
      ticker,
      kind: "market",
      event: raw.eventTicker || ticker,
      series: seriesOf(raw.eventTicker || ticker),
      title: raw.title,
      label: raw.subtitle ?? null,
      picked: null,
      end: storeOn() && raw.closeTime !== null && Date.parse(raw.closeTime) <= now ? Date.parse(raw.closeTime) : null,
      start: time(raw.openTime),
      stored,
    });
  }
  if (market.error.code !== "not_found") return market;
  const event = await liveEvent(ticker);
  if (!event.ok) return event;
  return eventCandidate({ ticker, series: event.data.series_ticker ?? seriesOf(ticker), title: event.data.title || ticker, markets: event.data.markets ?? [] }, stored, now);
}

/** A series ticker is an event ticker's first part (KXFEDDECISION-26DEC → KXFEDDECISION). */
const seriesOf = (eventTicker: string) => eventTicker.split("-")[0] || null;

/** A custom list: each ticker resolved as its page would resolve it, a few at a time. */
export async function tickerCandidates(tickers: string[], now = Date.now()): Promise<Result<CandidateList>> {
  const stored = (await readStore("stored tickers", (sql) => readStoredTickers(sql, tickers))) ?? new Set<string>();
  const results: Result<ScanCandidate>[] = new Array(tickers.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(LOOKUP_CONCURRENCY, tickers.length) }, async () => {
      while (next < tickers.length) {
        const i = next++;
        results[i] = await tickerCandidate(tickers[i], stored.has(tickers[i]), now);
      }
    }),
  );
  const list: CandidateList = { candidates: [], skipped: [], truncated: false };
  const seen = new Set<string>();
  results.forEach((r, i) => {
    if (!r.ok) return list.skipped.push({ ticker: tickers[i], reason: r.error.message });
    // A ticker listed twice is tested once. Two outcomes of one event stay (the user listed both);
    // the page groups them and says they're correlated.
    if (seen.has(r.data.ticker)) return;
    seen.add(r.data.ticker);
    list.candidates.push(r.data);
  });
  return ok(ordered(list));
}
