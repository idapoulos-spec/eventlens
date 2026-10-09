import "server-only";

import { headers } from "next/headers";
import { clientIp } from "./client-ip";
import { createRateLimiter, type RateLimitResult } from "./rate-limit";

// Each analysis costs up to 5 Twelve Data credits, with or without the data store: the quote, 2
// for the stock's bars unless they're in memory from the last minute, and 2 for Research's SPY
// benchmark unless it's in memory (see lib/market-data/benchmark.ts). So cap how often one
// client can run them.
const PER_MINUTE = 5;
const PER_HOUR = 30;

export const ANALYSIS_LIMIT_SUMMARY = `${PER_MINUTE} analyses a minute and ${PER_HOUR} an hour`;

const limiter = createRateLimiter([
  { windowMs: 60 * 1000, max: PER_MINUTE },
  { windowMs: 60 * 60 * 1000, max: PER_HOUR },
]);

/** Count one analysis against the caller's IP and report whether it is allowed. */
export async function checkAnalysisRateLimit(): Promise<RateLimitResult> {
  return limiter(clientIp(await headers()));
}
