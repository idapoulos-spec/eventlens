// Simulated scans for the scan's validation (scan-*.sim.test.ts): one stock and many Kalshi
// candidates on the same hourly grid, with no candidate related to the stock unless one is planted.
// Test-only; test-helpers.ts is left as it is, so every pinned scenario's data stays the same.

import { ALPHA } from "./inference";
import { HOUR_MS } from "./probability";
import { mulberry32, type Rng } from "./random";
import type { ResearchRow } from "./research";
import { correctScan, refineSteps, scanFirstStage, SCAN_REFINE_BELOW, type ScanInput } from "./scan";
import { drain } from "./steps";
import { normal } from "./test-helpers";

/**
 * - independent: each candidate's Kalshi path is its own (moves in 15% of quiet hours, as in
 *   simulateMarketRows).
 * - clustered: groups of five, like the meetings or outcomes of one series. A candidate's change is
 *   a market-wide part (moving in 4.5% of quiet hours), its group's part (9%), and its own (1.5%):
 *   about 0.9 correlation within a group and 0.3 across. The market-wide part also moves the
 *   benchmark (0.1% per pp: Kalshi tracks the market), and in hours it moves 1.5 pp or more the
 *   stock is three times as volatile.
 * In both, news days (20% of sessions) make every candidate move more and the stock 2.5 times as volatile.
 */
export type ScanStructure = "independent" | "clustered";

export const GROUP_SIZE = 5;

const RATES: Record<ScanStructure, { market: number; group: number; own: number }> = {
  independent: { market: 0, group: 0, own: 0.15 },
  clustered: { market: 0.045, group: 0.09, own: 0.015 },
};

export interface ScanSimOptions {
  candidates: number;
  structure: ScanStructure;
  seed: number;
  /** Trading sessions loaded and tested: 62 is the default 90-day window and its market-model sample. */
  sessions?: number;
  /** The candidate whose Kalshi changes move the stock, and by how much (% per pp). */
  planted?: { index: number; effect: number };
}

// As in test-helpers: the six hourly intervals ending 11:00…16:00 New York, U-shaped volatility,
// sessions in January 2026 (EST throughout).
const INTRADAY = [1.4, 1.0, 0.8, 0.8, 1.0, 1.3];
const FIRST_SESSION_10AM = Date.UTC(2026, 0, 5, 15);

function studentT(rng: Rng, df: number): number {
  let chi = 0;
  for (let i = 0; i < df; i++) chi += normal(rng) ** 2;
  return normal(rng) / Math.sqrt(chi / df) / Math.sqrt(df / (df - 2));
}

/** Kalshi-like changes (pp): zero most hours, 0.5 pp steps, moves that tend to continue (as kalshiPath). */
function sparsePath(rng: Rng, length: number, rate: number, active: boolean): number[] {
  const out: number[] = [];
  let prev = 0;
  for (let h = 0; h < length; h++) {
    const p = rate === 0 ? 0 : prev !== 0 ? 0.45 : active ? rate * 3 : rate;
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

export interface SimulatedScan {
  inputs: ScanInput[];
  /** Each candidate's group (clustered), or its own index (independent). */
  groups: number[];
  /** Each candidate's realized Kalshi changes in the trading hours, for checking the design. */
  changes: number[][];
}

export function simulateScan({ candidates, structure, seed, sessions = 62, planted }: ScanSimOptions): SimulatedScan {
  const rng = mulberry32(seed);
  const rates = RATES[structure];
  const groups = Array.from({ length: candidates }, (_, i) => (structure === "clustered" ? Math.floor(i / GROUP_SIZE) : i));
  const groupCount = Math.max(...groups) + 1;
  const probs = Array.from({ length: candidates }, () => 0.5);
  const rows: ResearchRow[][] = Array.from({ length: candidates }, () => []);
  const changes: number[][] = Array.from({ length: candidates }, () => []);
  const closes: { t: number; value: number }[] = [];
  let price = 100;
  let bench = 400;

  const push = (t: number) => {
    const step = Math.round(t / HOUR_MS);
    probs.forEach((p, i) => rows[i].push({ t, step, stockClose: price, kalshiValue: p, kalshiSource: "midpoint", kalshiAsOf: t, exclusion: null }));
    closes.push({ t, value: bench });
  };

  let day = 0;
  for (let s = 0; s < sessions; s++, day++) {
    if (day % 7 === 5) day += 2;
    const news = rng() < 0.2;
    const dayVol = Math.exp(0.4 * normal(rng)) * (news ? 2.5 : 1);
    const market = sparsePath(rng, INTRADAY.length, rates.market, news);
    const group = Array.from({ length: groupCount }, () => sparsePath(rng, INTRADAY.length, rates.group, news));
    const own = Array.from({ length: candidates }, () => sparsePath(rng, INTRADAY.length, rates.own, news));
    for (let h = 0; h <= INTRADAY.length; h++) {
      const t = FIRST_SESSION_10AM + day * 24 * HOUR_MS + h * HOUR_MS;
      if (h === 0) {
        // Overnight: across a gap in the grid, so no analysis uses it.
        const m = 0.004 * normal(rng);
        bench *= Math.exp(m);
        price *= Math.exp(1.1 * m + 0.006 * dayVol * normal(rng));
      } else {
        let plantedPp = 0;
        probs.forEach((p, i) => {
          const x = market[h - 1] + group[groups[i]][h - 1] + own[i][h - 1];
          const next = Math.min(0.99, Math.max(0.01, p + x / 100));
          const pp = (next - p) * 100;
          probs[i] = next;
          changes[i].push(pp);
          if (planted?.index === i) plantedPp = pp;
        });
        const m = 0.0015 * normal(rng) + (structure === "clustered" ? (0.1 * market[h - 1]) / 100 : 0);
        const spike = structure === "clustered" && Math.abs(market[h - 1]) >= 1.5 ? 3 : 1;
        bench *= Math.exp(m);
        price *= Math.exp(1.1 * m + ((planted?.effect ?? 0) * plantedPp) / 100 + 0.002 * dayVol * INTRADAY[h - 1] * spike * studentT(rng, 5));
      }
      push(t);
    }
  }
  return {
    inputs: rows.map((full) => ({ full, from: full[0].t - 1, resolution: "hourly", scale: 100, closes })),
    groups,
    changes,
  };
}

/** What one scan decided. */
export interface ScanOutcome {
  /** Candidates with a p-value (m). */
  tested: number;
  /** Candidates whose first p was under SCAN_REFINE_BELOW (R). */
  refined: number;
  /** First-stage p-values (as on each candidate's own page), and the p the corrections used. */
  firstPs: (number | null)[];
  ps: (number | null)[];
  survivesHolm: boolean[];
  survivesBh: boolean[];
}

/**
 * The scan's decisions for one simulated scan, computed as the page computes them, except that
 * with `early` a candidate's finer p stops once it's sure to end above R·α/m. That never changes a
 * decision: past rank R every p is at least SCAN_REFINE_BELOW, above every threshold either
 * correction can use, so a candidate survives only with p < kα/m for some k ≤ R (BH), or below
 * α/(m − k + 1) ≤ Rα/m (Holm); and the order of the p-values under R·α/m, which is all either
 * decision reads, doesn't depend on the exact values above it. scan-sim.test.ts checks it.
 */
export function runScan(inputs: ScanInput[], { early = true }: { early?: boolean } = {}): ScanOutcome {
  const first = inputs.map((input) => scanFirstStage(input, { withFragility: false }));
  const firstPs = first.map((f) => f.primary?.p ?? null);
  const tested = firstPs.filter((p) => p !== null).length;
  const refined = firstPs.filter((p) => p !== null && p < SCAN_REFINE_BELOW).length;
  const bound = (refined * ALPHA) / Math.max(tested, 1);
  const ps = first.map((f, i) => (f.refine ? drain(refineSteps(f.refine, early ? { stopAbove: bound } : {})).p : firstPs[i]));
  const correction = correctScan(ps);
  return {
    tested,
    refined,
    firstPs,
    ps,
    survivesHolm: correction.map((c) => c.survivesHolm),
    survivesBh: correction.map((c) => c.survivesBh),
  };
}

/** A rate with one Monte Carlo standard error and a 95% Wilson interval, for reporting. */
export function rateSummary(count: number, n: number): { rate: number; se: number; lo: number; hi: number } {
  const rate = count / n;
  const z = 1.959964;
  const centre = (rate + (z * z) / (2 * n)) / (1 + (z * z) / n);
  const half = (z * Math.sqrt((rate * (1 - rate)) / n + (z * z) / (4 * n * n))) / (1 + (z * z) / n);
  return { rate, se: Math.sqrt((rate * (1 - rate)) / n), lo: centre - half, hi: centre + half };
}

/** How often scans with no related candidate show something, over `count` simulated scans from seed `first`. */
export interface NullRates {
  scans: number;
  /** Scans with at least one candidate surviving Holm, or Benjamini–Hochberg. */
  holm: number;
  bh: number;
  /** Scans with at least one first-stage p under 0.05: what reading each page on its own would find. */
  rawAny: number;
  /** Candidates whose first-stage p is under 0.05, of all candidates tested. */
  candidateRejections: number;
  candidates: number;
  /** Candidates refined, in all. */
  refined: number;
}

export function nullRates(options: Omit<ScanSimOptions, "seed" | "planted">, first: number, count: number): NullRates {
  const rates: NullRates = { scans: 0, holm: 0, bh: 0, rawAny: 0, candidateRejections: 0, candidates: 0, refined: 0 };
  for (let seed = first; seed < first + count; seed++) {
    const out = runScan(simulateScan({ ...options, seed }).inputs);
    const raw = out.firstPs.filter((p) => p !== null && p < ALPHA).length;
    rates.scans++;
    if (out.survivesHolm.some(Boolean)) rates.holm++;
    if (out.survivesBh.some(Boolean)) rates.bh++;
    if (raw > 0) rates.rawAny++;
    rates.candidateRejections += raw;
    rates.candidates += out.tested;
    rates.refined += out.refined;
  }
  return rates;
}
