import "server-only";

import type { ExpectedPoint } from "@/lib/analytics/research";
import { findEvent, loadEvent, loadEventLong } from "@/lib/expected/load";
import { findKalshiMarket, researchWindowOf } from "@/lib/history/market";
import { getLongResearchHistory, getResearchHistory } from "@/lib/history/research";
import { fail, ok, type Result } from "@/lib/result";
import type { ScanKalshi } from "./types";

// One candidate's Kalshi side, read by the loaders its own page uses: the data store first, the live
// API (or Kalshi's archive) for the rest. The longer history only when the scan's window needs it.

const toPoint = ({ t, value, sumP, openSet, missing }: ExpectedPoint): ExpectedPoint => ({ t, value, sumP, openSet, missing });

async function marketKalshi(ticker: string, long: boolean, asOf: number | null): Promise<Result<ScanKalshi>> {
  const found = findKalshiMarket(ticker);
  const window = researchWindowOf(found, asOf);
  const [f, history, longHistory, w] = await Promise.all([
    found,
    getResearchHistory(ticker, window),
    long ? getLongResearchHistory(ticker, window) : Promise.resolve(ok(null)),
    window,
  ]);
  if (!f.ok) return f;
  if (!history.ok) return history;
  if (!longHistory.ok) return fail(longHistory.error.code, "Its longer history couldn't be loaded.");
  const close = f.data.market.closeTime === null ? NaN : Date.parse(f.data.market.closeTime);
  return ok({
    kind: "market",
    points: history.data.points,
    closeTime: Number.isFinite(close) ? close : null,
    long: longHistory.data && { points: longHistory.data.points, start: longHistory.data.start },
    end: w.end,
    start: w.start,
    ...(w.frozen && { frozen: true as const }),
    provenance: history.data.provenance,
  });
}

async function eventKalshi(ticker: string, long: boolean, asOf: number | null): Promise<Result<ScanKalshi>> {
  const found = await findEvent(ticker);
  if (!found.ok) return found;
  const now = Date.now();
  const [event, longMarks] = await Promise.all([loadEvent(found.data, now, asOf), long ? loadEventLong(found.data, now, asOf) : Promise.resolve(ok(null))]);
  // As the event page decides Research is unavailable (EventDashboard's noExpected).
  if (event.problem !== null || event.outcomes.some((o) => o.unmapped !== null)) {
    return fail("unmapped", "Its outcomes can't all be given values, so it has no expected value.");
  }
  if (!event.marks.some((m) => m.value !== null)) return fail("no_expected", "Its expected value is missing at every hour in the window.");
  if (!longMarks.ok) return fail(longMarks.error.code, "Its longer history couldn't be loaded.");
  return ok({
    kind: "event",
    marks: event.marks.map(toPoint),
    long: longMarks.data && { marks: longMarks.data.marks.map(toPoint), start: longMarks.data.start },
    end: event.window.end,
    start: event.window.start,
    ...(event.window.frozen && { frozen: true as const }),
    provenance: event.provenance,
  });
}

/** A candidate's Kalshi side as its page reads it; with `asOf`, as its frozen page does. Never rejects. */
export function loadCandidateKalshi(ticker: string, kind: "event" | "market", long: boolean, asOf: number | null = null): Promise<Result<ScanKalshi>> {
  return kind === "event" ? eventKalshi(ticker, long, asOf) : marketKalshi(ticker, long, asOf);
}
