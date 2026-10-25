import "server-only";

import { lookUpMarket, normalizeMarket } from "@/lib/kalshi/client";
import { getHistoricalMarket } from "@/lib/kalshi/historical";
import { marketPhase } from "@/lib/kalshi/status";
import type { KalshiMarket } from "@/lib/kalshi/types";
import { ok, type Result } from "@/lib/result";
import { readStoredMarket } from "./kalshi";
import { readStore, storeOn } from "./store";
import type { FoundMarket, ResearchWindow } from "./types";
import { LIVE_WINDOW, windowFor } from "./window";

// The dashboard's one market lookup. Kalshi's live endpoints answer 404 for a market that
// settled before its archive cutoff (GET /historical/cutoff); with the store on, such a market
// comes from its stored row or, if it isn't stored, from the archive. The lookup lives here, not
// in lib/kalshi/client.ts, because the archive client (historical.ts) imports that file.

/** A Kalshi market: live first, then (with the store on) stored, then from Kalshi's archive. */
export async function findKalshiMarket(ticker: string): Promise<Result<FoundMarket>> {
  const live = await lookUpMarket(ticker);
  if (live.ok) return ok({ market: live.data, archived: false });
  if (live.error.code !== "not_found" || !storeOn()) return live;

  // A stored row the collector last saw before it settled would show stale quotes as live, so
  // only a settled one is used; otherwise the archive has the final state.
  const stored = await readStore("Kalshi market", (sql) => readStoredMarket(sql, ticker));
  if (stored && marketPhase(stored.raw.status ?? "") === "settled") {
    return ok({ market: normalizeMarket(stored.raw), archived: true });
  }
  const archived = await getHistoricalMarket(ticker);
  if (archived.ok) return ok({ market: normalizeMarket(archived.data), archived: true });
  // Not in the archive either: say so as the live lookup does.
  return archived.error.code === "not_found" ? live : archived;
}

/** The market alone, for the Kalshi panel. */
export function marketOf(found: Promise<Result<FoundMarket>>): Promise<Result<KalshiMarket>> {
  return found.then((r) => (r.ok ? ok(r.data.market) : r));
}

/**
 * Where Research's window ends (a closed market's close, with the store on; otherwise now) and
 * where its longer windows can start (the market's open). It waits for the market lookup, so the
 * stock's bars reach back only as far as the market's life needs. With `asOf` (a frozen link),
 * it ends at that time, or at the close if the market had closed by then, store or not.
 */
export function researchWindowOf(found: Promise<Result<FoundMarket>>, asOf: number | null = null): Promise<ResearchWindow> {
  return found.then((r) => {
    if (!r.ok) return asOf === null ? LIVE_WINDOW : { ...LIVE_WINDOW, end: asOf, frozen: true };
    const window = windowFor(r.data, Date.now(), asOf);
    // Without the store, Research ends now, as it always has.
    return storeOn() || asOf !== null ? window : { ...LIVE_WINDOW, start: window.start };
  });
}
