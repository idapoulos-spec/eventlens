// Shared by the scan's routes: their parameters, and how failures map to HTTP statuses. Pure.

import { MAX_SCAN_CANDIDATES } from "@/lib/analytics/scan";
import { validateKalshiTicker } from "@/lib/validation";
import type { PriceSpan } from "./span";
import type { ScanErrorResponse } from "./types";

/**
 * Upstream failures are the server's (5xx; the page retries the ones that pass), a candidate that
 * can't be tested is 422 (the page lists it as untested), bad input 400.
 */
const STATUS: Record<string, number> = {
  missing_key: 503,
  rate_limited: 503,
  unavailable: 503,
  timeout: 504,
  not_found: 404,
  plan: 403,
  too_long: 400,
  no_store: 400,
  unsupported: 422,
  unmapped: 422,
  no_expected: 422,
  no_markets: 422,
  invalid_data: 502,
};

export function scanError(status: number, code: string, message: string, headers?: HeadersInit): Response {
  const body: ScanErrorResponse = { error: { code, message } };
  return Response.json(body, { status, headers });
}

export function upstreamError({ code, message }: { code: string; message: string }): Response {
  const status = STATUS[code] ?? 502;
  return scanError(status, code, message, status === 503 ? { "Retry-After": "2" } : undefined);
}

/**
 * Twelve Data's free plan allows 8 requests a minute (the calendar minute) for every user of the
 * key together, and requests it turns away count toward it too, so trying again sooner only wastes
 * them: 429, to retry 2 s into the next minute.
 */
export function perMinuteLimit(message: string, now: number): Response {
  const wait = Math.ceil((60_000 - (now % 60_000)) / 1000) + 2;
  return scanError(429, "upstream_rate_limited", message, { "Retry-After": String(wait) });
}

/** Statuses the page tries again (after a pause): the upstream API was busy or slow. */
export const RETRY_STATUSES = new Set([429, 503, 504]);

const SERIES = /^[A-Z0-9]{1,40}$/;

/** A series ticker, e.g. KXFEDDECISION. */
export function parseSeries(raw: string | null): { ok: true; value: string } | { ok: false; message: string } {
  const value = (raw ?? "").trim().toUpperCase();
  return SERIES.test(value) ? { ok: true, value } : { ok: false, message: "Enter a Kalshi series ticker, e.g. KXFEDDECISION." };
}

/** A custom list: tickers separated by commas, spaces, or new lines; at most MAX_SCAN_CANDIDATES. */
export function parseTickers(raw: string | null): { ok: true; value: string[] } | { ok: false; message: string } {
  const parts = [...new Set((raw ?? "").split(/[\s,]+/).filter(Boolean).map((t) => t.toUpperCase()))];
  if (parts.length === 0) return { ok: false, message: "Add at least one Kalshi ticker." };
  if (parts.length > MAX_SCAN_CANDIDATES) return { ok: false, message: `A scan takes at most ${MAX_SCAN_CANDIDATES} candidates.` };
  for (const p of parts) {
    const v = validateKalshiTicker(p);
    if (!v.ok) return { ok: false, message: v.message };
  }
  return { ok: true, value: parts };
}

const EARLIEST = Date.UTC(2015, 0, 1);
const whole = (raw: string | null) => (raw !== null && /^\d{1,15}$/.test(raw) ? Number(raw) : NaN);

/** The span's bounds (ms) and whether it runs to now, from the page's request. */
export function parseSpan(params: URLSearchParams, now: number): { ok: true; value: PriceSpan } | { ok: false; message: string } {
  const from = whole(params.get("from"));
  const to = whole(params.get("to"));
  const live = params.get("live") === "1";
  if (!(from >= EARLIEST && to > from && to <= now + 60_000)) return { ok: false, message: "The scan's dates are out of range." };
  return { ok: true, value: { from, to: live ? now : to, live } };
}

export const spanParams = ({ from, to, live }: PriceSpan) => new URLSearchParams({ from: String(Math.floor(from)), to: String(Math.ceil(to)), live: live ? "1" : "0" });

/** A frozen scan's as-of time (ms since 1970), on each of its requests: every window still open then ends there. */
export const SCAN_ASOF_PARAM = "asof";

/** The as-of time of a scan's request: absent (null), or whole ms from 2015 up to now. */
export function parseScanAsOf(params: URLSearchParams, now: number): { ok: true; value: number | null } | { ok: false; message: string } {
  const raw = params.get(SCAN_ASOF_PARAM);
  if (raw === null) return { ok: true, value: null };
  const ms = /^\d{1,15}$/.test(raw) ? Number(raw) : NaN;
  return ms >= EARLIEST && ms <= now ? { ok: true, value: ms } : { ok: false, message: "The scan's as-of time must be a past time." };
}
