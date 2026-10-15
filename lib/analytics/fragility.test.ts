import { describe, expect, it } from "vitest";
import { computeChanges } from "./changes";
import { blockKey, primaryFrame } from "./correlation-test";
import {
  decisionFlips,
  effectiveCount,
  FRAGILE,
  fragileReasons,
  fragility,
  leaveOneOut,
  primaryWithout,
  type Fragility,
  type LeaveOneOut,
} from "./fragility";
import type { TestResult } from "./inference";
import { adjustedChanges, benchmarkReturnsByT, fitMarketModel, primaryTest } from "./market-model";
import { lastSessions, simulateMarketRows } from "./test-helpers";
import { wildDraws } from "./wild-bootstrap";

const DRAWS = 199;
const NY = "America/New_York";
const nyDate = (t: number) => new Intl.DateTimeFormat("en-CA", { timeZone: NY }).format(t);

/** One simulated analysis as the page runs it: rows, the market model on all of them, the window's changes and abnormal returns. */
function analysis({ sessions, window, resolution = "hourly", seed, effect = 0 }: { sessions: number; window: number; resolution?: "hourly" | "daily"; seed: number; effect?: number }) {
  const { rows: full, closesByT } = simulateMarketRows({ sessions, resolution, seed, effect, sharedVolatility: true, kalshiInMarket: 0.1 });
  const rows = lastSessions(full, window, resolution);
  const changes = computeChanges(rows, 100).changes;
  const model = fitMarketModel(full, closesByT)!;
  const abnormal = adjustedChanges(changes, benchmarkReturnsByT(full, closesByT), model);
  return { full, closesByT, changes, model, abnormal, resolution };
}

describe("effectiveCount", () => {
  it("is Kish's (Σw)²/Σw²: n for equal weights, fewer when a few dominate", () => {
    expect(effectiveCount([1, 1, 1, 1])).toBe(4);
    expect(effectiveCount([0.25, 0.25, 0.25, 0.25])).toBe(4);
    // One weight of 0.46 and the rest spread thin: at most 1/0.46² ≈ 4.7.
    expect(effectiveCount([0.46, ...Array(54).fill(0.01)])).toBeCloseTo(1 / (0.46 ** 2 + 54 * 0.01 ** 2), 12);
    expect(effectiveCount([5])).toBe(1);
    expect(effectiveCount([])).toBe(0);
  });
});

describe("fragility", () => {
  const a = analysis({ sessions: 62, window: 62, seed: 900 });
  const f = fragility(a.abnormal, a.model, "hourly")!;
  const pf = primaryFrame(a.abnormal, "hourly", a.model.sample)!;

  it("splits the estimate's numerator into session scores that add up to it", () => {
    let numerator = 0;
    for (let t = 0; t < pf.f.n; t++) numerator += pf.f.q[t] * pf.f.a[t];
    expect(numerator).toBeCloseTo(pf.f.slope * pf.f.sxx, 15);
    // The ranked sessions' scores are each one's Σq·a, and their shares are scores² over the total.
    const total = f.sessions.ranked[0].score ** 2 / f.sessions.ranked[0].share;
    for (const s of f.sessions.ranked) expect(s.share).toBeCloseTo(s.score ** 2 / total, 12);
    expect(f.sessions.count).toBe(62);
    expect(f.sessions.ranked).toHaveLength(FRAGILE.leaveOut);
    expect(f.sessions.ranked.map((s) => s.share)).toEqual([...f.sessions.ranked.map((s) => s.share)].sort((x, y) => y - x));
    expect(f.sessions.top1).toBe(f.sessions.ranked[0].share);
    expect(f.sessions.top10).toBeCloseTo(f.sessions.ranked.reduce((sum, s) => sum + s.share, 0), 12);
  });

  it("shares Kalshi's movement by interval: weights x̌²/Σx̌², and Kish's count of them", () => {
    const w = Array.from(pf.f.xc, (v) => (v * v) / pf.f.sxx).sort((x, y) => y - x);
    expect(f.movement.top1).toBeCloseTo(w[0], 15);
    expect(f.movement.top5).toBeCloseTo(w.slice(0, 5).reduce((s, v) => s + v, 0), 15);
    expect(f.movement.effective).toBeCloseTo(1 / w.reduce((s, v) => s + v * v, 0), 9);
    expect(f.movement.intervals).toBe(a.abnormal.length);
    expect(f.movement.moves).toBe(a.abnormal.filter((c) => c.kalshiChange !== 0).length);
  });

  it("lists the window's intervals that push the estimate most, largest |q·a| first", () => {
    expect(f.hours).toHaveLength(10);
    const sizes = f.hours.map((h) => Math.abs(h.contribution));
    expect(sizes).toEqual([...sizes].sort((x, y) => y - x));
    for (const h of f.hours) {
      const p = pf.sorted.findIndex((c) => c.t === h.t);
      const j = pf.f.index[p];
      expect(h.contribution).toBeCloseTo(pf.f.q[j] * pf.f.a[j], 15);
      // The abnormal return is the market model's residual, as the page's adjusted changes have it.
      expect(h.abnormal).toBeCloseTo(a.abnormal[a.abnormal.findIndex((c) => c.t === h.t)].logReturn, 12);
      expect(h.kalshiChange).toBe(pf.sorted[p].kalshiChange);
    }
    expect(f.hours.every((h) => h.sessionRank >= 1 && h.sessionRank <= 62)).toBe(true);
  });

  it("keeps each session within one New York trading date, across the daylight-saving switch", () => {
    // 62 sessions from Jan 5, 2026 run past Mar 8, when New York moves to UTC−4.
    const long = fragility(a.abnormal, a.model, "hourly")!;
    expect(a.full.at(-1)!.t).toBeGreaterThan(Date.UTC(2026, 2, 9));
    for (const s of long.sessions.ranked) expect(nyDate(s.from)).toBe(nyDate(s.to));
  });

  it("finds the hour that carries a planted move first, and says how concentrated movement is", () => {
    // One large Kalshi move in a quiet window, with a large abnormal return in the same hour.
    const rows = a.full.map((r) => ({ ...r }));
    const target = rows.length - 20;
    for (let i = target; i < rows.length; i++) rows[i].kalshiValue! += 0.2;
    for (let i = target; i < rows.length; i++) rows[i].stockClose *= 1.03;
    const changes = computeChanges(rows, 100).changes;
    const model = fitMarketModel(rows, a.closesByT)!;
    const planted = fragility(adjustedChanges(changes, benchmarkReturnsByT(rows, a.closesByT), model), model, "hourly")!;
    expect(planted.hours[0].t).toBe(rows[target].t);
    expect(planted.hours[0].kalshiChange).toBeCloseTo(a.abnormal.find((c) => c.t === rows[target].t)!.kalshiChange + 20, 9);
    expect(planted.movement.top1).toBeGreaterThan(0.5);
    expect(planted.movement.effective).toBeLessThan(FRAGILE.minEffectiveMoves);
    expect(planted.hours[0].sessionRank).toBe(1);
  });
});

describe("the bootstrap's numerator under the null", () => {
  it("has variance Σs² exactly: every one of the 6³ Webb sign patterns on three sessions", () => {
    const { rows: full, closesByT } = simulateMarketRows({ sessions: 3, resolution: "hourly", seed: 901, sharedVolatility: true });
    const model = fitMarketModel(full, closesByT)!;
    const abnormal = adjustedChanges(computeChanges(full, 100).changes, benchmarkReturnsByT(full, closesByT), model);
    const pf = primaryFrame(abnormal, "hourly", model.sample)!;
    const f = fragility(abnormal, model, "hourly")!;
    expect(f.sessions.count).toBe(3);

    const webb = [-Math.sqrt(1.5), -1, -Math.sqrt(0.5), Math.sqrt(0.5), 1, Math.sqrt(1.5)];
    const patterns = webb.flatMap((x) => webb.flatMap((y) => webb.map((z) => Float64Array.from([x, y, z]))));
    expect(patterns).toHaveLength(216);
    const draws = wildDraws(pf.f, patterns);
    let second = 0;
    for (let d = 0; d < patterns.length; d++) second += draws[d * 5] ** 2 / patterns.length;
    const scores = f.sessions.ranked.map((s) => s.score);
    expect(second).toBeCloseTo(scores.reduce((s, v) => s + v * v, 0), 15);
  });
});

describe("leaveOneOut", () => {
  const a = analysis({ sessions: 30, window: 30, seed: 902, effect: 0.15 });
  const primary = primaryTest(a.abnormal, a.model, "hourly", { draws: DRAWS });
  const frag = fragility(a.abnormal, a.model, "hourly")!;
  const input = { full: a.full, closesByT: a.closesByT, changes: a.changes, resolution: "hourly" as const, primary, fragility: frag, draws: DRAWS };

  it("gives exactly the primary test when nothing is left out", () => {
    expect(primaryWithout(input, new Set(), DRAWS)).toEqual(primary);
  });

  it("gives the same test as rows built without the session", () => {
    const key = frag.sessions.ranked[0].key;
    const without = a.full.filter((r) => blockKey(r.t, r.step, frag.blocking.first, null) !== key);
    expect(without.length).toBe(a.full.length - 7);
    const model = fitMarketModel(without, a.closesByT)!;
    const changes = computeChanges(without, 100).changes;
    const expected = primaryTest(adjustedChanges(changes, benchmarkReturnsByT(without, a.closesByT), model), model, "hourly", { draws: DRAWS });
    expect(primaryWithout(input, new Set([key]), DRAWS)).toEqual(expected);
  });

  it("reruns the ten most influential sessions in rank order, then all of them together", () => {
    const loo = leaveOneOut(input);
    expect(loo.runs.map((r) => r.rank)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    expect(loo.runs.map((r) => r.session)).toEqual(frag.sessions.ranked);
    for (const r of loo.runs) {
      expect(r.test.resampling?.units).toBe(29);
      expect(r.flips).toBe(decisionFlips(primary, r.test));
    }
    expect(loo.together.resampling?.units).toBe(20);
    const ps = loo.runs.map((r) => r.test.p!);
    expect(loo.p).toEqual([Math.min(...ps), Math.max(...ps)]);
    expect(loo.flips).toBe(loo.runs.filter((r) => r.flips).length);
    expect(loo.unavailable).toBe(0);
  });

  it("leaves a run without a p-value when too few sessions remain, and counts it", () => {
    // 8 sessions: enough for the primary test, but 7 are left in each rerun.
    const small = analysis({ sessions: 8, window: 8, seed: 903 });
    const smallPrimary = primaryTest(small.abnormal, small.model, "hourly", { draws: DRAWS });
    const smallFrag = fragility(small.abnormal, small.model, "hourly")!;
    const loo = leaveOneOut({ ...input, ...small, primary: smallPrimary, fragility: smallFrag });
    expect(smallPrimary.p).not.toBeNull();
    expect(loo.runs).toHaveLength(8);
    expect(loo.unavailable).toBe(8);
    expect(loo.flips).toBe(0);
    expect(loo.p).toBeNull();
  });
});

describe("decisionFlips", () => {
  const test = (p: number | null, estimate: number) => ({ p, estimate }) as TestResult;

  it("flips when p crosses 0.05 either way, or a significant estimate changes sign", () => {
    expect(decisionFlips(test(0.03, 0.2), test(0.07, 0.15))).toBe(true);
    expect(decisionFlips(test(0.2, 0.1), test(0.04, 0.2))).toBe(true);
    expect(decisionFlips(test(0.01, 0.2), test(0.02, -0.1))).toBe(true);
    expect(decisionFlips(test(0.2, 0.1), test(0.3, -0.1))).toBe(false);
    expect(decisionFlips(test(0.01, 0.2), test(0.04, 0.1))).toBe(false);
    expect(decisionFlips(test(0.2, 0.1), test(null, 0.1))).toBe(false);
  });
});

describe("fragileReasons", () => {
  const f = (moves: number, sessions: number) => ({ movement: { effective: moves }, sessions: { effective: sessions } }) as Fragility;
  const loo = (flips: number) => ({ flips }) as LeaveOneOut;

  it("names each check that trips, at the thresholds fixed before any result", () => {
    expect(FRAGILE).toEqual({ minEffectiveMoves: 10, minEffectiveSessions: 8, leaveOut: 10 });
    expect(fragileReasons(f(10, 8), loo(0))).toEqual([]);
    expect(fragileReasons(f(9.99, 8), null)).toEqual(["movement"]);
    expect(fragileReasons(f(10, 7.99), loo(0))).toEqual(["sessions"]);
    expect(fragileReasons(f(4.7, 4.7), loo(2))).toEqual(["movement", "sessions", "leave_one_out"]);
  });
});

