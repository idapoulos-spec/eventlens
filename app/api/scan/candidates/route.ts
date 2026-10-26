import type { NextRequest } from "next/server";
import { rejectUnlessSignedIn } from "@/lib/auth/session";
import { clientIp } from "@/lib/client-ip";
import { createRateLimiter } from "@/lib/rate-limit";
import { parseScanAsOf, parseSeries, parseTickers, scanError, upstreamError } from "@/lib/scan/api";
import { seriesCandidates, storedCandidates, tickerCandidates, type CandidateList } from "@/lib/scan/candidates";

// A custom list resolves each ticker with Kalshi (a few at a time), so a long list takes a while.
export const maxDuration = 60;

// Each listing costs Kalshi requests only (no Twelve Data credits).
const limiter = createRateLimiter([
  { windowMs: 60 * 1000, max: 20 },
  { windowMs: 60 * 60 * 1000, max: 200 },
]);

/**
 * GET /api/scan/candidates → CandidateList, one candidate per event:
 * - ?scope=series&series=KXFEDDECISION[&settled=1]: the series' open events (and its stored settled ones);
 * - ?scope=stored[&series=…]: every stored event, settled ones included;
 * - ?scope=tickers&tickers=A,B,…: a custom list.
 * With &asof=… (a frozen scan), windows end at that time, or at the close of a candidate that had closed by then.
 */
export async function GET(request: NextRequest) {
  const denied = await rejectUnlessSignedIn(request.cookies);
  if (denied) return denied;

  const params = request.nextUrl.searchParams;
  const scope = params.get("scope");
  const parsed = parseScanAsOf(params, Date.now());
  if (!parsed.ok) return scanError(400, "invalid_asof", parsed.message);
  const asOf = parsed.value;
  let load: () => Promise<{ ok: true; data: CandidateList } | { ok: false; error: { code: string; message: string } }>;
  if (scope === "series") {
    const series = parseSeries(params.get("series"));
    if (!series.ok) return scanError(400, "invalid_series", series.message);
    load = () => seriesCandidates(series.value, { settled: params.get("settled") === "1" }, Date.now(), asOf);
  } else if (scope === "stored") {
    const raw = params.get("series");
    const series = raw ? parseSeries(raw) : null;
    if (series && !series.ok) return scanError(400, "invalid_series", series.message);
    load = () => storedCandidates(series ? series.value : null, Date.now(), asOf);
  } else if (scope === "tickers") {
    const tickers = parseTickers(params.get("tickers"));
    if (!tickers.ok) return scanError(400, "invalid_tickers", tickers.message);
    load = () => tickerCandidates(tickers.value, Date.now(), asOf);
  } else {
    return scanError(400, "invalid_scope", "Pick a series, the stored events, or a list of tickers.");
  }

  const limit = limiter(clientIp(request.headers));
  if (!limit.ok) return scanError(429, "rate_limited", "Too many candidate lists. Please wait a moment and try again.", { "Retry-After": String(limit.retryAfterSec) });

  const list = await load();
  if (!list.ok) return upstreamError(list.error);
  return Response.json(list.data);
}
