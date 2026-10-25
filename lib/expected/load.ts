import "server-only";

import { kalshiGet, KalshiHttpError, toNumber, windowEndSec } from "@/lib/kalshi/client";
import { toKalshiCandles, type KalshiCandle } from "@/lib/kalshi/candles";
import { getHistoricalCandles } from "@/lib/kalshi/historical";
import type { RawEvent, RawMarket, RawMarketCandlesticks } from "@/lib/kalshi/types";
import { marketPhase } from "@/lib/kalshi/status";
import { splitWindows } from "@/lib/collect/kalshi/ranges";
import { coveragePlan, mergeByTime } from "@/lib/history/merge";
import { ARCHIVE_DEADLINE_MS, LONG_DEADLINE_MS, TAIL_OVERLAP_MS, withDeadline } from "@/lib/history/research";
import { readStore, storeOn } from "@/lib/history/store";
import type { Provenance, ResearchWindow } from "@/lib/history/types";
import { closedOr, KALSHI_HISTORY_MS, LIVE_WINDOW, longHistoryStart, RESEARCH_WINDOW_MS } from "@/lib/history/window";
import { LIVE } from "@/lib/fetch-cache";
import { DEFAULT_BENCHMARK } from "@/lib/market-data/benchmark-series";
import { getBenchmarkSeries } from "@/lib/market-data/benchmark";
import { getStockOverview } from "@/lib/market-data/twelve-data";
import { isTimeout } from "@/lib/request-timeout";
import { fail, ok, type Result } from "@/lib/result";
import type { TimeRange } from "@/lib/store/runs";
import { microsToDollars } from "@/lib/store/units";
import { changeSince, chartPoints, currentExpected, eventPhase, lastValid, outcomeRows, weightPoints, type OutcomeBook } from "./analysis";
import { expectedAt, hourlyMarks, Outcome, type ExpectedMark, type OutcomeCandle, type OutcomeHistory, type OutcomeState } from "./engine";
import { gapsIn, liveOutcome, storedOutcome, withLive, type OutcomeMeta } from "./history";
import { mapEvent } from "./mapping";
import { supportedEvent, type ExpectedSeries } from "./series";
import { readStoredHistory, readStoredOutcomes, type StoredHistory, type StoredOutcome } from "./store";
import type { EventAnalysis, ExpectedNow } from "./types";

// An event's analysis: its outcomes from Kalshi (or, once archived, the store or Kalshi's archive),
// each outcome's hourly books for 97 days from the store first and the live API for the rest, and
// E from them. Read-only; nothing here writes to the store.

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
const LOOKBACK_MS = 7 * DAY_MS;
/** Kalshi answers 400 when one batch request spans more candles than this, across its tickers. */
export const MAX_BATCH_CANDLES = 10_000;

/** An event and its outcome markets as found. */
export interface FoundEvent {
  ticker: string;
  series: ExpectedSeries;
  title: string;
  subtitle: string | null;
  mutuallyExclusive: boolean | null;
  /** Each outcome as Kalshi returned it: live (with books), stored, or from the archive. */
  markets: RawMarket[];
  /** The live endpoints no longer list the markets: they settled before Kalshi's archive cutoff. */
  archived: boolean;
  /** Stored rows, for the coverage plan; empty without the store. */
  stored: StoredOutcome[];
}

function describeError(err: unknown, ticker: string): Result<never> {
  if (err instanceof KalshiHttpError && err.status === 404) return fail("not_found", `No Kalshi event found with ticker "${ticker}".`);
  if (err instanceof KalshiHttpError && err.status === 429) {
    return fail("rate_limited", "Kalshi rate limit reached. Please wait a moment and try again.");
  }
  if (isTimeout(err)) return fail("timeout", "Kalshi didn't respond in time. Please try again shortly.");
  if (err instanceof RangeError) return fail("invalid_data", "Kalshi returned a price or count outside its valid range.");
  return fail("unavailable", "Could not reach the Kalshi API. Please try again shortly.");
}

const time = (iso: string | null | undefined) => {
  const ms = iso ? Date.parse(iso) : NaN;
  return Number.isFinite(ms) ? ms : null;
};

/** The event, with its markets nested while the live endpoints serve them. */
async function getEvent(ticker: string): Promise<Result<RawEvent>> {
  try {
    const data = await kalshiGet<{ event: RawEvent; markets?: RawMarket[] }>(`/events/${encodeURIComponent(ticker)}?with_nested_markets=true`, LIVE);
    return ok({ ...data.event, markets: data.event.markets?.length ? data.event.markets : (data.markets ?? []) });
  } catch (err) {
    return describeError(err, ticker);
  }
}

/** An archived event's markets from Kalshi's archive. */
async function getArchivedMarkets(ticker: string): Promise<Result<RawMarket[]>> {
  try {
    const query = new URLSearchParams({ event_ticker: ticker, limit: "100" });
    const { markets } = await kalshiGet<{ markets?: RawMarket[] }>(`/historical/markets?${query}`, LIVE);
    return ok(markets ?? []);
  } catch (err) {
    return describeError(err, ticker);
  }
}

/**
 * An event and its outcomes: live first. Once its markets settle before Kalshi's archive cutoff,
 * the live event lists none, so they come from the store (settled rows only) or the archive.
 */
export async function findEvent(ticker: string): Promise<Result<FoundEvent>> {
  const series = supportedEvent(ticker);
  if (!series) return fail("unsupported", `"${ticker}" isn't an event EventLens can analyze as a whole.`);
  const [live, stored] = await Promise.all([
    getEvent(ticker),
    storeOn() ? readStore("Kalshi event", (sql) => readStoredOutcomes(sql, ticker)) : Promise.resolve(null),
  ]);
  const storedRows = stored ?? [];
  if (!live.ok && (live.error.code === "not_found" || storedRows.length === 0)) return live;

  const event = live.ok ? live.data : null;
  const base = {
    ticker,
    series,
    title: event?.title || ticker,
    subtitle: event?.sub_title || null,
    mutuallyExclusive: event?.mutually_exclusive ?? null,
    stored: storedRows,
  };
  if (event?.markets?.length) return ok({ ...base, markets: event.markets, archived: false });

  // Archived. A stored row last seen before it settled would show stale quotes, so only settled ones count.
  if (storedRows.length > 0 && storedRows.every((o) => marketPhase(o.status) === "settled")) {
    return ok({ ...base, markets: storedRows.map((o) => o.raw), archived: true });
  }
  const archived = await getArchivedMarkets(ticker);
  if (!archived.ok) return archived;
  return ok({ ...base, markets: archived.data, archived: true });
}

/** The first outcome's close (ms), or null if none has one. */
export function firstCloseOf(markets: RawMarket[]): number | null {
  const closes = markets.map((m) => time(m.close_time)).filter((t): t is number => t !== null);
  return closes.length > 0 ? Math.min(...closes) : null;
}

/** The first outcome's open (ms), or null if none has one. */
export function firstOpenOf(markets: RawMarket[]): number | null {
  const opens = markets.map((m) => time(m.open_time)).filter((t): t is number => t !== null);
  return opens.length > 0 ? Math.min(...opens) : null;
}

/**
 * Research ends at the event's first close once that has passed (E isn't defined after it),
 * otherwise now; its longer windows start no earlier than the first outcome's open. With `asOf`
 * (a frozen link), it ends there instead of now, and at the first close only if that had passed by then.
 */
export function eventWindow(found: FoundEvent, now: number, asOf: number | null = null): ResearchWindow {
  return closedOr(firstCloseOf(found.markets), { archived: found.archived, start: firstOpenOf(found.markets) }, now, asOf);
}

export function eventWindowOf(found: Promise<Result<FoundEvent>>, asOf: number | null = null): Promise<ResearchWindow> {
  return found.then((r) => (r.ok ? eventWindow(r.data, Date.now(), asOf) : asOf === null ? LIVE_WINDOW : { ...LIVE_WINDOW, end: asOf, frozen: true }));
}

const toBook = ({ endTs, yesBid, yesAsk }: KalshiCandle): OutcomeCandle => ({
  endTs,
  bid: microsToDollars(yesBid.close),
  ask: microsToDollars(yesAsk.close),
});

/** [startSec, endSec] as windows of at most MAX_PERIODS_PER_WINDOW hours (one window for 97 days), in seconds. */
const timeWindows = (startSec: number, endSec: number) =>
  splitWindows({ from: startSec * 1000, to: endSec * 1000 }, "60").map((w) => ({ startSec: w.from / 1000, endSec: w.to / 1000 }));

/** Books from several windows as one series, oldest first; a candle on a shared edge is kept once. */
const mergeBooks = (lists: OutcomeCandle[][]): OutcomeCandle[] =>
  mergeByTime([], lists.flat().map((c) => ({ ...c, t: c.endTs }))).map(({ endTs, bid, ask }) => ({ endTs, bid, ask }));

/**
 * Live hourly books for several markets ending in [startSec, endSec], in as few requests as Kalshi
 * allows: at most MAX_BATCH_CANDLES across a request's tickers, so a span past that is split in time too.
 */
async function getLiveBooks(tickers: string[], startSec: number, endSec: number): Promise<Result<Map<string, OutcomeCandle[]>>> {
  const requests = timeWindows(startSec, endSec).flatMap((w) => {
    const perRequest = Math.max(1, Math.floor(MAX_BATCH_CANDLES / Math.ceil((w.endSec - w.startSec) / 3600)));
    const chunks: string[][] = [];
    for (let i = 0; i < tickers.length; i += perRequest) chunks.push(tickers.slice(i, i + perRequest));
    return chunks.map((chunk) => ({ chunk, ...w }));
  });
  try {
    const responses = await Promise.all(
      requests.map(({ chunk, startSec, endSec }) => {
        const query = new URLSearchParams({
          market_tickers: chunk.join(","),
          start_ts: String(startSec),
          end_ts: String(endSec),
          period_interval: "60",
        });
        // Not cached: several markets' 97 days can pass the 2 MB Next.js caches.
        return kalshiGet<{ markets?: RawMarketCandlesticks[] }>(`/markets/candlesticks?${query}`, LIVE);
      }),
    );
    const lists = new Map<string, OutcomeCandle[][]>(tickers.map((t) => [t, []]));
    for (const m of responses.flatMap((r) => r.markets ?? [])) {
      lists.get(m.market_ticker)?.push(toKalshiCandles(m.candlesticks ?? []).map(toBook));
    }
    return ok(new Map([...lists].map(([t, l]) => [t, l.length === 1 ? l[0] : mergeBooks(l)])));
  } catch (err) {
    return describeError(err, tickers.join(", "));
  }
}

/** An archived market's hourly books, a request per window of at most 4,800 hours, giving up after ARCHIVE_DEADLINE_MS. */
async function getArchivedBooks(ticker: string, startSec: number, endSec: number): Promise<Result<OutcomeCandle[]>> {
  const windows = timeWindows(startSec, endSec);
  const results = await Promise.all(
    windows.map((w) =>
      withDeadline(
        getHistoricalCandles(ticker, { ...w, periodMinutes: 60 }).then((r) => (r.ok ? ok(r.data.map(toBook)) : r)),
        ARCHIVE_DEADLINE_MS,
        () => fail("timeout", "Kalshi didn't respond in time. Please try again shortly."),
      ),
    ),
  );
  const failed = results.find((r) => !r.ok);
  if (failed) return failed;
  const lists = results.map((r) => (r.ok ? r.data : []));
  return ok(lists.length === 1 ? lists[0] : mergeBooks(lists));
}

interface Histories {
  histories: OutcomeHistory[];
  provenance: Provenance;
  error: string | null;
}

/**
 * Each mapped outcome's history over `range`: stored when the store covers it, stored plus a live
 * tail when only its end is missing, otherwise live. Live requests go out together: one batch
 * (or a few) for live markets, one request per market for archived ones.
 */
async function loadHistories(found: FoundEvent, metas: OutcomeMeta[], range: TimeRange): Promise<Histories> {
  const stored: StoredHistory | null =
    storeOn() && found.stored.length > 0 ? await readStore("Kalshi event history", (sql) => readStoredHistory(sql, found.ticker, range)) : null;
  const storedTickers = new Set(found.stored.map((o) => o.ticker));

  // What each outcome needs: the store alone (through `through`), a live tail after it, or
  // everything live. Candles exist only while a market is listed.
  const plans = metas.map((meta) => {
    if (!stored || !storedTickers.has(meta.ticker)) return { meta, from: range.from, kind: "live" as const, through: null };
    const need = { from: Math.max(range.from, meta.openTime ?? range.from), to: Math.min(range.to, meta.closeTime ?? range.to) };
    const plan = need.from < need.to ? coveragePlan(gapsIn(stored.covered.get(meta.ticker) ?? [], range), need) : ({ kind: "stored" } as const);
    if (plan.kind === "tail") return { meta, from: Math.max(range.from, plan.from - TAIL_OVERLAP_MS), kind: "tail" as const, through: plan.from };
    if (plan.kind === "stored") return { meta, from: range.from, kind: "stored" as const, through: Math.max(need.from, need.to) };
    return { meta, from: range.from, kind: "live" as const, through: null };
  });

  const fetching = plans.filter((p) => p.kind !== "stored");
  const endSec = range.to / 1000;
  const live = new Map<string, Result<OutcomeCandle[]>>();
  let liveFrom: number | null = null;
  if (fetching.length > 0) {
    liveFrom = Math.min(...fetching.map((p) => p.from));
    const startSec = Math.floor(liveFrom / 1000);
    if (found.archived) {
      const results = await Promise.all(fetching.map((p) => getArchivedBooks(p.meta.ticker, startSec, endSec)));
      fetching.forEach((p, i) => live.set(p.meta.ticker, results[i]));
    } else {
      const books = await getLiveBooks(
        fetching.map((p) => p.meta.ticker),
        startSec,
        endSec,
      );
      for (const p of fetching) live.set(p.meta.ticker, books.ok ? ok(books.data.get(p.meta.ticker) ?? []) : books);
    }
  }

  let storedThrough: number | null = null;
  let error: string | null = null;
  let liveFailed = false;
  const histories = plans.map(({ meta, kind, through }) => {
    const fetched = { from: liveFrom ?? range.from, to: range.to };
    const result = live.get(meta.ticker);
    if (kind === "live") {
      if (result?.ok) return liveOutcome(meta, result.data, fetched);
      error ??= result && !result.ok ? result.error.message : null;
      // Nothing loaded: every mark is a collection gap, so E stays missing rather than guessed.
      return { ...liveOutcome(meta, [], fetched), covered: [] };
    }
    const base = storedOutcome(meta, stored!);
    storedThrough = storedThrough === null ? through : Math.min(storedThrough, through!);
    if (kind === "stored") return base;
    if (result?.ok) return withLive(base, result.data, fetched);
    liveFailed = true;
    return base;
  });
  if (liveFailed) console.warn("[store] live Kalshi candles after the stored event history unavailable; serving stored history");
  return { histories, provenance: { storedThrough, liveFrom, liveFailed }, error };
}

/**
 * A whole event's analysis, from its found outcomes. With `asOf` (a frozen link), everything ends
 * there, as for an event past its first close: E and its history at that time. Never rejects.
 */
export async function loadEvent(found: FoundEvent, fetchedAt = Date.now(), asOf: number | null = null): Promise<EventAnalysis> {
  const mapping = mapEvent(found.markets, found.mutuallyExclusive);
  const books: OutcomeBook[] = found.markets.map((m) => ({
    ticker: m.ticker,
    label: m.yes_sub_title || null,
    status: m.status ?? "unknown",
    result: m.result || null,
    openTime: time(m.open_time),
    closeTime: time(m.close_time),
    bid: toNumber(m.yes_bid_dollars),
    ask: toNumber(m.yes_ask_dollars),
  }));
  const firstClose = firstCloseOf(found.markets);
  const window = eventWindow(found, fetchedAt, asOf);
  // Minute boundaries, as the single-market history (windowEndSec).
  const to = windowEndSec(window.end ?? fetchedAt) * 1000;
  const from = to - RESEARCH_WINDOW_MS;
  const phase = eventPhase(books);
  const decidedBook = books.find((b) => b.result === "yes");
  const base = {
    ticker: found.ticker,
    title: found.title,
    subtitle: found.subtitle,
    unit: found.series.unit,
    label: found.series.label,
    mutuallyExclusive: found.mutuallyExclusive,
    problem: mapping.problem,
    phase,
    firstClose,
    decided: decidedBook ? { ticker: decidedBook.ticker, label: decidedBook.label ?? decidedBook.ticker } : null,
    window,
    from,
    to,
    fetchedAt,
  };

  if (mapping.outcomes.length === 0) {
    const none = { value: null, from: null, unavailable: "no_current" as const };
    return {
      ...base,
      outcomes: outcomeRows(books, mapping, null, new Map(), null, phase === "open"),
      current: { t: fetchedAt, value: null, sumP: null, openSet: [], missing: "unmapped" },
      change1h: none,
      change24h: none,
      marks: [],
      chart: [],
      weights: [],
      provenance: { storedThrough: null, liveFrom: null, liveFailed: false },
      historyError: null,
    };
  }

  const bookOf = new Map(books.map((b) => [b.ticker, b]));
  const metas: OutcomeMeta[] = mapping.outcomes.map((o) => ({
    ticker: o.ticker,
    value: o.value,
    openTime: bookOf.get(o.ticker)!.openTime,
    closeTime: bookOf.get(o.ticker)!.closeTime,
  }));
  // A week before the marks, so each mark finds the latest candle within its 7-day lookback.
  const { histories, provenance, error } = await loadHistories(found, metas, { from: to - KALSHI_HISTORY_MS, to });
  const outcomes = histories.map((h) => new Outcome(h));
  const marks = expectedAt(outcomes, hourlyMarks(from, to));

  let current: ExpectedNow | null;
  let states = new Map<string, OutcomeState>();
  let mark = null;
  if (phase === "open" && window.end === null) {
    ({ now: current, states } = currentExpected(outcomes, bookOf, fetchedAt));
  } else {
    mark = lastValid(marks);
    current = mark && { t: mark.t, value: mark.value, sumP: mark.sumP, openSet: mark.openSet, missing: null };
  }
  const live = phase === "open" && window.end === null;
  const rows = outcomeRows(books, mapping, current, states, mark, live);
  return {
    ...base,
    outcomes: rows,
    current,
    change1h: live ? changeSince(current, marks, HOUR_MS) : { value: null, from: null, unavailable: "no_current" },
    change24h: live ? changeSince(current, marks, DAY_MS) : { value: null, from: null, unavailable: "no_current" },
    marks,
    chart: chartPoints(marks),
    weights: weightPoints(
      marks,
      rows.filter((o) => o.value !== null).map((o) => o.ticker),
    ),
    provenance,
    historyError: error,
  };
}

/** E for Research's longer windows: every top of the hour from where they start to the window's end. */
export interface LongMarks {
  marks: ExpectedMark[];
  /** The longer windows start here (ms): the first outcome's open, or LONG_HISTORY_MS before the end. */
  start: number;
  provenance: Provenance;
}

/**
 * E over Research's longer windows, from each outcome's history over them (store first, as for the
 * 90 days). Null when the event is no older than the 90 days the page already has, or its outcomes
 * can't be mapped; a failure when the history can't be loaded in LONG_DEADLINE_MS. Never rejects.
 */
export async function loadEventLong(found: FoundEvent, fetchedAt = Date.now(), asOf: number | null = null): Promise<Result<LongMarks | null>> {
  const mapping = mapEvent(found.markets, found.mutuallyExclusive);
  const window = eventWindow(found, fetchedAt, asOf);
  const to = windowEndSec(window.end ?? fetchedAt) * 1000;
  const start = longHistoryStart(window.start, to);
  if (mapping.outcomes.length === 0 || start >= to - RESEARCH_WINDOW_MS) return ok(null);
  const byTicker = new Map(found.markets.map((m) => [m.ticker, m]));
  const metas: OutcomeMeta[] = mapping.outcomes.map((o) => ({
    ticker: o.ticker,
    value: o.value,
    openTime: time(byTicker.get(o.ticker)?.open_time),
    closeTime: time(byTicker.get(o.ticker)?.close_time),
  }));
  const load = async (): Promise<Result<LongMarks | null>> => {
    // A week before the first mark, as for the 90 days, on a minute boundary.
    const from = Math.floor((start - LOOKBACK_MS) / 60_000) * 60_000;
    const { histories, provenance, error } = await loadHistories(found, metas, { from, to });
    if (error !== null) return fail("unavailable", error);
    const outcomes = histories.map((h) => new Outcome(h));
    const marks = expectedAt(outcomes, hourlyMarks(start, to));
    return ok({ marks, start, provenance });
  };
  return withDeadline(load(), LONG_DEADLINE_MS, () => fail("timeout", "Kalshi's longer history didn't load in time."));
}

/**
 * Starts every request a whole-event analysis needs, as loadAnalysis does for one market, and
 * returns a promise per section; none rejects. The stock's history waits for the event lookup,
 * which says whether Research ends now or at the event's first close; its default benchmark waits
 * for the stock, so the stock gets the shared Twelve Data quota first.
 */
export function loadEventAnalysis(stock: string, ticker: string, { asOf = null }: { asOf?: number | null } = {}) {
  const found = findEvent(ticker);
  const window = eventWindowOf(found, asOf);
  const event = found.then(async (r): Promise<Result<EventAnalysis>> => (r.ok ? ok(await loadEvent(r.data, Date.now(), asOf)) : r));
  // Research's longer windows: loaded alongside, and streamed after the page's first render.
  const long = found.then((r): Promise<Result<LongMarks | null>> => (r.ok ? loadEventLong(r.data, Date.now(), asOf) : Promise.resolve(ok(null))));
  const stockData = getStockOverview(stock, window);
  const benchmarkData = Promise.all([stockData, window]).then(([s, { end, frozen }]) =>
    s.ok && stock !== DEFAULT_BENCHMARK.symbol ? getBenchmarkSeries(DEFAULT_BENCHMARK.symbol, { end, frozen }) : null,
  );
  return { event, stockData, benchmarkData, long };
}
