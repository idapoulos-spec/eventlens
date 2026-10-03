// Simulated data for the Research statistics tests: Kalshi changes that are mostly zero, move
// in 0.5 pp steps and reprice over several hours, and stock returns whose volatility changes
// by day, by hour of day, and with news.

import type { ChangePoint } from "./changes";
import { HOUR_MS } from "./probability";
import { mulberry32, type Rng } from "./random";
import type { ResearchRow } from "./research";

/** Standard normal draw (Box–Muller). */
export function normal(rng: Rng): number {
  const u = 1 - rng();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rng());
}

/** Student's t draw with `df` degrees of freedom, scaled to unit variance. */
function studentT(rng: Rng, df: number): number {
  let chi = 0;
  for (let i = 0; i < df; i++) chi += normal(rng) ** 2;
  return normal(rng) / Math.sqrt(chi / df) / Math.sqrt(df / (df - 2));
}

export interface SimOptions {
  /** Trading sessions (hourly) or days (daily). */
  sessions: number;
  seed: number;
  /** Stock return (log) per 1 pp Kalshi change, `lag` slots later. 0 = no relationship. */
  beta?: number;
  lag?: number;
  /**
   * News days on which Kalshi moves more and the stock is more volatile, and hours in which
   * a big Kalshi move comes with a big stock move of random sign: dependence in volatility,
   * none in direction.
   */
  sharedVolatility?: boolean;
  /** Chance that Kalshi moves in a quiet hour. */
  moveRate?: number;
}

// Intraday volatility for the six hourly intervals ending 11:00…16:00 New York: U-shaped.
const INTRADAY = [1.4, 1.0, 0.8, 0.8, 1.0, 1.3];
// January 2026, so New York is on EST (UTC−5) throughout: 10:00 New York = 15:00 UTC.
const FIRST_SESSION_10AM = Date.UTC(2026, 0, 5, 15);

/** Kalshi changes (pp): zero most hours, 0.5 pp steps, moves that tend to continue. */
function kalshiPath(rng: Rng, length: number, rate: number, active: boolean): number[] {
  const out: number[] = [];
  let prev = 0;
  for (let h = 0; h < length; h++) {
    const p = prev !== 0 ? 0.45 : active ? rate * 3 : rate;
    if (rng() < p) {
      const size = 0.5 * (1 + Math.floor(-Math.log(1 - rng()) * (active ? 2.5 : 1.2)));
      const sign = prev !== 0 && rng() < 0.7 ? Math.sign(prev) : rng() < 0.5 ? -1 : 1;
      prev = sign * size;
    } else {
      prev = 0;
    }
    out.push(prev);
  }
  return out;
}

/** Hourly changes over `sessions` weekday sessions, six intervals each. */
export function simulateHourly({ sessions, seed, beta = 0, lag = 0, sharedVolatility = false, moveRate = 0.15 }: SimOptions): ChangePoint[] {
  const rng = mulberry32(seed);
  const changes: ChangePoint[] = [];
  let day = 0;
  for (let s = 0; s < sessions; s++, day++) {
    if (day % 7 === 5) day += 2; // skip weekends
    const news = sharedVolatility && rng() < 0.2;
    const dayVol = Math.exp(0.4 * normal(rng)) * (news ? 2.5 : 1);
    const x = kalshiPath(rng, INTRADAY.length, moveRate, news);
    const noise = INTRADAY.map((v, h) => {
      const spike = sharedVolatility && Math.abs(x[h]) >= 1.5 ? 3 : 1;
      return 0.002 * dayVol * v * spike * studentT(rng, 5);
    });
    x.forEach((xh, h) => {
      const t = FIRST_SESSION_10AM + day * 24 * HOUR_MS + (h + 1) * HOUR_MS;
      const source = h - lag;
      const signal = source >= 0 && source < x.length ? (beta * x[source]) / 100 : 0;
      changes.push({ t, step: Math.round(t / HOUR_MS), probChangePp: xh, logReturn: noise[h] + signal });
    });
  }
  return changes;
}

/** Daily changes over `sessions` trading days (consecutive steps), with volatility regimes. */
export function simulateDaily({ sessions, seed, beta = 0, lag = 0, sharedVolatility = false, moveRate = 0.5 }: SimOptions): ChangePoint[] {
  const rng = mulberry32(seed);
  const x = kalshiPath(rng, sessions, moveRate, false).map((v) => v * 2);
  let vol = 1;
  return x.map((xd, i) => {
    vol = Math.exp(0.9 * Math.log(vol) + 0.25 * normal(rng));
    const spike = sharedVolatility && Math.abs(xd) >= 3 ? 2.5 : 1;
    const source = i - lag;
    const signal = source >= 0 ? (beta * x[source]) / 100 : 0;
    const t = Date.UTC(2026, 0, 5, 21) + i * 24 * HOUR_MS;
    return { t, step: i, probChangePp: xd, logReturn: 0.012 * vol * spike * studentT(rng, 5) + signal };
  });
}

/**
 * Hourly research rows with a stock path and Kalshi probabilities: `sessions` sessions of
 * seven top-of-hour closes (10:00–16:00 New York). `drift(i)` adds a log return to the
 * interval ending at row i, e.g. an effect after Kalshi jumps.
 */
export function simulateRows({
  sessions,
  seed,
  sharedVolatility = false,
  moveRate = 0.12,
  drift,
}: SimOptions & { drift?: (row: number, rows: ResearchRow[]) => number }): ResearchRow[] {
  const rng = mulberry32(seed);
  const rows: ResearchRow[] = [];
  let price = 100;
  let prob = 0.5;
  let day = 0;
  for (let s = 0; s < sessions; s++, day++) {
    if (day % 7 === 5) day += 2;
    const news = sharedVolatility && rng() < 0.2;
    const dayVol = Math.exp(0.4 * normal(rng)) * (news ? 2.5 : 1);
    const x = kalshiPath(rng, INTRADAY.length, moveRate, news);
    for (let h = 0; h <= INTRADAY.length; h++) {
      const t = FIRST_SESSION_10AM + day * 24 * HOUR_MS + h * HOUR_MS;
      if (h > 0) {
        const spike = sharedVolatility && Math.abs(x[h - 1]) >= 1.5 ? 3 : 1;
        prob = Math.min(0.99, Math.max(0.01, prob + x[h - 1] / 100));
        price *= Math.exp(0.002 * dayVol * INTRADAY[h - 1] * spike * studentT(rng, 5));
      } else {
        price *= Math.exp(0.006 * dayVol * normal(rng)); // overnight
      }
      rows.push({ t, step: Math.round(t / HOUR_MS), stockClose: price, probability: prob, kalshiSource: "midpoint", kalshiAsOf: t, exclusion: null });
      if (drift) rows[rows.length - 1].stockClose = price *= Math.exp(drift(rows.length - 1, rows));
    }
  }
  return rows;
}
