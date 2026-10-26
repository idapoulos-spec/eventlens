import "server-only";

import { splitWindows } from "@/lib/collect/kalshi/ranges";
import { LIVE } from "@/lib/fetch-cache";
import { getHourlyHistory, getKalshiResearchHistory, windowEndSec } from "@/lib/kalshi/client";
import { getHistoricalCandles } from "@/lib/kalshi/historical";
import type { KalshiPoint } from "@/lib/kalshi/types";
import { fail, ok, type Result } from "@/lib/result";
import { readStoredKalshiWindow } from "./kalshi";
import { candlePoints, coveragePlan, mergeByTime } from "./merge";
import { readStore, storeOn } from "./store";
import type { TimeRange } from "@/lib/store/runs";
import type { LongHistory, Provenance, ResearchHistory, ResearchWindow } from "./types";
import { KALSHI_HISTORY_MS, longHistoryStart, RESEARCH_WINDOW_MS } from "./window";

// Research's Kalshi history: stored candles first, the live API for what the store doesn't cover.

const HOUR_MS = 60 * 60 * 1000;
/** A live tail starts this long before the stored history ends, so the two overlap. */
export const TAIL_OVERLAP_MS = 2 * HOUR_MS;
/**
 * The archive's candle requests may take 20 s (CANDLES_TIMEOUT_MS) for a full response; a
 * 97-day window is a fraction of that, so Research gives up sooner and the page stays well
 * inside its time limit.
 */
export const ARCHIVE_DEADLINE_MS = 10_000;
/**
 * Research's longer windows give up on Kalshi after this long. They load after the page's first
 * render, so they wait no more than the rest of the page, whose worst chain is about 32 s of its 40.
 */
export const LONG_DEADLINE_MS = 15_000;
/** The history before a window reaches back a week, to find the probability in effect when it starts. */
const LOOKBACK_MS = 7 * 24 * 60 * 60 * 1000;

const LIVE_ONLY: Provenance = { storedThrough: null, liveFrom: null, liveFailed: false };

/** Settles to `promise`'s value, or to `late()` if it takes longer than `ms`. */
export function withDeadline<T>(promise: Promise<T>, ms: number, late: () => T): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<T>((resolve) => {
    timer = setTimeout(() => resolve(late()), ms);
  });
  return Promise.race([promise, deadline]).finally(() => clearTimeout(timer));
}

/** Hourly points from candles ending in [startSec, endSec]: Kalshi's archive for an archived market, else the live endpoint. */
async function fetchLive(ticker: string, startSec: number, endSec: number, archived: boolean, cache?: RequestInit): Promise<Result<KalshiPoint[]>> {
  if (!archived) return getHourlyHistory(ticker, startSec, endSec, cache);
  const candles = await withDeadline(getHistoricalCandles(ticker, { startSec, endSec, periodMinutes: 60 }), ARCHIVE_DEADLINE_MS, () =>
    fail("timeout", "Kalshi didn't respond in time. Please try again shortly."),
  );
  return candles.ok ? ok(candlePoints(candles.data)) : candles;
}

/**
 * fetchLive over any span: windows of at most MAX_PERIODS_PER_WINDOW hours (the archive allows
 * 5,000 a request, the live endpoint 10,000), fetched at once and merged. Not cached: a long
 * window's responses can pass the 2 MB Next.js caches.
 */
async function fetchLiveSpan(ticker: string, startSec: number, endSec: number, archived: boolean): Promise<Result<KalshiPoint[]>> {
  const windows = splitWindows({ from: startSec * 1000, to: endSec * 1000 }, "60");
  const results = await Promise.all(windows.map((w) => fetchLive(ticker, w.from / 1000, w.to / 1000, archived, LIVE)));
  const failed = results.find((r) => !r.ok);
  if (failed) return failed;
  return ok(results.reduce<KalshiPoint[]>((all, r) => mergeByTime(all, r.ok ? r.data : []), []));
}

type LiveFetch = (startSec: number, endSec: number) => Promise<Result<KalshiPoint[]>>;

/**
 * A market's hourly points over `range` (minute boundaries) with the store on: stored candles, a
 * live tail after them, or everything live, as the store's coverage requires.
 */
async function storedOrLive(ticker: string, range: TimeRange, live: LiveFetch): Promise<Result<ResearchHistory>> {
  const startSec = range.from / 1000;
  const endSec = range.to / 1000;
  const liveWindow = async (): Promise<Result<ResearchHistory>> => {
    const points = await live(startSec, endSec);
    return points.ok ? ok({ points: points.data, provenance: { ...LIVE_ONLY, liveFrom: range.from } }) : points;
  };

  const stored = await readStore("Kalshi history", (sql) => readStoredKalshiWindow(sql, ticker, range));
  if (!stored?.market) return liveWindow();

  // Candles exist only while the market is listed, and Research reads nothing after its close.
  const { openTime, closeTime } = stored.market;
  const need = { from: Math.max(range.from, openTime ?? range.from), to: Math.min(range.to, closeTime ?? range.to) };
  const plan = need.from < need.to ? coveragePlan(stored.gaps, need) : ({ kind: "stored" } as const);
  const points = candlePoints(stored.candles);

  if (plan.kind === "stored") {
    return ok({ points, provenance: { ...LIVE_ONLY, storedThrough: need.to } });
  }
  if (plan.kind === "live") return liveWindow();

  const liveFrom = plan.from - TAIL_OVERLAP_MS;
  const tail = await live(Math.floor(liveFrom / 1000), endSec);
  if (!tail.ok) {
    console.warn(`[store] live Kalshi candles after the stored history unavailable (${tail.error.code}); serving stored history`);
    return ok({ points, provenance: { storedThrough: plan.from, liveFrom: null, liveFailed: true } });
  }
  return ok({ points: mergeByTime(points, tail.data), provenance: { storedThrough: plan.from, liveFrom, liveFailed: false } });
}

/**
 * Hourly implied-probability points for Research: 97 days ending at the window's end (now, a
 * closed market's close, or a frozen link's as-of time). Without the store, a window ending now
 * is exactly the live request it has always been, and one ending in the past is read live.
 */
export async function getResearchHistory(ticker: string, researchWindow: Promise<ResearchWindow>): Promise<Result<ResearchHistory>> {
  const { end, archived } = await researchWindow;
  if (!storeOn() && end === null) {
    const live = await getKalshiResearchHistory(ticker);
    return live.ok ? ok({ points: live.data, provenance: LIVE_ONLY }) : live;
  }

  // Minute boundaries, as the live client's windows (windowEndSec).
  const endSec = windowEndSec(end ?? Date.now());
  const startSec = endSec - KALSHI_HISTORY_MS / 1000;
  return storedOrLive(ticker, { from: startSec * 1000, to: endSec * 1000 }, (from, to) => fetchLive(ticker, from, to, archived));
}

/**
 * Hourly points for Research's longer windows: from a week before where they start (the market's
 * open, at most LONG_HISTORY_MS before the window's end) to the end, from the store first. Null
 * when the market is no older than the 90 days the page already has, so a longer window adds
 * nothing. Gives up after LONG_DEADLINE_MS, so the page, which streams this after its first
 * render, finishes in time. Never rejects.
 */
export async function getLongResearchHistory(ticker: string, researchWindow: Promise<ResearchWindow>): Promise<Result<LongHistory | null>> {
  const { end, archived, start } = await researchWindow;
  const endSec = windowEndSec(end ?? Date.now());
  const longStart = longHistoryStart(start, endSec * 1000);
  if (longStart >= endSec * 1000 - RESEARCH_WINDOW_MS) return ok(null);
  const range = { from: Math.floor((longStart - LOOKBACK_MS) / 60_000) * 60_000, to: endSec * 1000 };
  const live: LiveFetch = (from, to) => fetchLiveSpan(ticker, from, to, archived);
  const load = async (): Promise<Result<LongHistory | null>> => {
    const history = storeOn()
      ? await storedOrLive(ticker, range, live)
      : await live(range.from / 1000, range.to / 1000).then((r) => (r.ok ? ok({ points: r.data, provenance: { ...LIVE_ONLY, liveFrom: range.from } }) : r));
    return history.ok ? ok({ ...history.data, start: longStart }) : history;
  };
  return withDeadline(load(), LONG_DEADLINE_MS, () => fail("timeout", "Kalshi's longer history didn't load in time."));
}
