import "server-only";

import { headers } from "next/headers";
import { createRateLimiter, type RateLimitResult } from "./rate-limit";

// Each analysis costs up to 3 Twelve Data credits, so cap how often one client can run them.
const PER_MINUTE = 5;
const PER_HOUR = 30;

export const ANALYSIS_LIMIT_SUMMARY = `${PER_MINUTE} analyses a minute and ${PER_HOUR} an hour`;

const limiter = createRateLimiter([
  { windowMs: 60 * 1000, max: PER_MINUTE },
  { windowMs: 60 * 60 * 1000, max: PER_HOUR },
]);

/**
 * Best-effort client IP. On Vercel, x-real-ip and x-forwarded-for are set by
 * Vercel's network and overwrite anything the client sends. Elsewhere they are
 * only as trustworthy as the proxy in front of the app.
 */
async function getClientIp(): Promise<string> {
  const h = await headers();
  const forwarded = h.get("x-forwarded-for")?.split(",")[0]?.trim();
  return h.get("x-real-ip") || forwarded || "unknown";
}

/** Count one analysis against the caller's IP and report whether it is allowed. */
export async function checkAnalysisRateLimit(): Promise<RateLimitResult> {
  return limiter(await getClientIp());
}
