import "server-only";

import { getHourlyHistory, getKalshiResearchHistory, windowEndSec } from "@/lib/kalshi/client";
import { getHistoricalCandles } from "@/lib/kalshi/historical";
import type { KalshiPoint } from "@/lib/kalshi/types";
import { fail, ok, type Result } from "@/lib/result";
import { readStoredKalshiWindow } from "./kalshi";
import { candlePoints, coveragePlan, mergeByTime } from "./merge";
import { readStore, storeOn } from "./store";
import type { Provenance, ResearchHistory, ResearchWindow } from "./types";
import { KALSHI_HISTORY_MS } from "./window";

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

const LIVE_ONLY: Provenance = { storedThrough: null, liveFrom: null, liveFailed: false };

/** Settles to `promise`'s value, or to `late()` if it takes longer than `ms`. */
function withDeadline<T>(promise: Promise<T>, ms: number, late: () => T): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<T>((resolve) => {
    timer = setTimeout(() => resolve(late()), ms);
  });
  return Promise.race([promise, deadline]).finally(() => clearTimeout(timer));
}

/** Hourly points from candles ending in [startSec, endSec]: Kalshi's archive for an archived market, else the live endpoint. */
async function fetchLive(ticker: string, startSec: number, endSec: number, archived: boolean): Promise<Result<KalshiPoint[]>> {
  if (!archived) return getHourlyHistory(ticker, startSec, endSec);
  const candles = await withDeadline(getHistoricalCandles(ticker, { startSec, endSec, periodMinutes: 60 }), ARCHIVE_DEADLINE_MS, () =>
    fail("timeout", "Kalshi didn't respond in time. Please try again shortly."),
  );
  return candles.ok ? ok(candlePoints(candles.data)) : candles;
}

/**
 * Hourly implied-probability points for Research: 97 days ending at the window's end (now, or a
 * closed market's close). Without the store, exactly the live request it has always been.
 */
export async function getResearchHistory(ticker: string, researchWindow: Promise<ResearchWindow>): Promise<Result<ResearchHistory>> {
  const { end, archived } = await researchWindow;
  if (!storeOn()) {
    const live = await getKalshiResearchHistory(ticker);
    return live.ok ? ok({ points: live.data, provenance: LIVE_ONLY }) : live;
  }

  // Minute boundaries, as the live client's windows (windowEndSec).
  const endSec = windowEndSec(end ?? Date.now());
  const startSec = endSec - KALSHI_HISTORY_MS / 1000;
  const range = { from: startSec * 1000, to: endSec * 1000 };
  const liveWindow = async (): Promise<Result<ResearchHistory>> => {
    const live = await fetchLive(ticker, startSec, endSec, archived);
    return live.ok ? ok({ points: live.data, provenance: { ...LIVE_ONLY, liveFrom: range.from } }) : live;
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
  const tail = await fetchLive(ticker, Math.floor(liveFrom / 1000), endSec, archived);
  if (!tail.ok) {
    console.warn(`[store] live Kalshi candles after the stored history unavailable (${tail.error.code}); serving stored history`);
    return ok({ points, provenance: { storedThrough: plan.from, liveFrom: null, liveFailed: true } });
  }
  return ok({ points: mergeByTime(points, tail.data), provenance: { storedThrough: plan.from, liveFrom, liveFailed: false } });
}
