import { describe, expect, it } from "vitest";
import { computeChanges } from "./changes";
import { DESCRIPTIVE_MIN_SESSIONS, fragileReasons, fragility, leaveOneOut, type FragileReason } from "./fragility";
import { adjustedChanges, benchmarkReturnsByT, fitMarketModel, primaryTest } from "./market-model";
import { lastSessions, simulateMarketRows, type MarketSimOptions } from "./test-helpers";

// How often the fragile warning's checks fire on simulated data (in its own file so it runs
// alongside long-windows.test.ts). Seeds 600,000–689,199, fresh when first run; figures in the README.

// Simulations run hundreds of analyses; allow for slow CI machines.
const SIMULATION_TIMEOUT = 600_000;
const DRAWS = 199;
const seeds = (first: number, count: number) => Array.from({ length: count }, (_, i) => first + i);
const hourly = { resolution: "hourly", sharedVolatility: true, kalshiInMarket: 0.1 } as const;

/** One simulated analysis as the page runs it: the window is the last `window` of the loaded sessions. */
function sample(options: MarketSimOptions, window: number) {
  const { rows: full, closesByT } = simulateMarketRows(options);
  const model = fitMarketModel(full, closesByT)!;
  const changes = computeChanges(lastSessions(full, window, options.resolution), 100).changes;
  return { full, closesByT, model, changes, abnormal: adjustedChanges(changes, benchmarkReturnsByT(full, closesByT), model) };
}

describe("simulations: how often the fragile warning fires", () => {
  // Not calibration: these runs report how often each check fires on simulated data, with no link
  // and with a same-hour effect of 0.3% per pp. Hourly, Kalshi tracking the benchmark, shared
  // volatility; the window is the last `window` of 62 sessions up to 90 days, every session beyond.
  // Leave-one-out with 199 draws. F1 and F3 are the warning's thresholds, fixed before any result.
  // F2 (fewer than 8 effective sessions) was part of it until 2026-10-19, when these same runs
  // showed it firing in almost every data set with no link (most sessions have no Kalshi movement),
  // so it's now only described on the page; it's still counted here, as the reason for that change.
  function warnings(window: number, effect: number, first: number) {
    const count: Record<FragileReason | "fewSessions" | "any" | "tested", number> = { movement: 0, fewSessions: 0, leave_one_out: 0, any: 0, tested: 0 };
    for (const seed of seeds(first, 200)) {
      const s = sample({ ...hourly, sessions: Math.max(62, window), seed, effect }, window);
      const primary = primaryTest(s.abnormal, s.model, "hourly", { draws: DRAWS });
      const f = primary.p === null ? null : fragility(s.abnormal, s.model, "hourly");
      if (!f) continue;
      const loo = leaveOneOut({ full: s.full, closesByT: s.closesByT, changes: s.changes, resolution: "hourly", primary, fragility: f, draws: DRAWS });
      const reasons = fragileReasons(f, loo);
      count.tested++;
      for (const r of reasons) count[r]++;
      if (f.sessions.effective < DESCRIPTIVE_MIN_SESSIONS) count.fewSessions++;
      if (reasons.length > 0) count.any++;
    }
    return count;
  }

  it("fires less often as windows grow, with and without an effect", () => {
    const results = [21, 62, 124, 252].map((window, i) => ({
      none: warnings(window, 0, 600_000 + 10_000 * i),
      effect: warnings(window, 0.3, 650_000 + 10_000 * i),
    }));
    for (const { none, effect } of results) {
      for (const c of [none, effect]) {
        expect(c.tested).toBe(200);
        // The warning is F1 or F3, nothing else.
        expect(c.any).toBeGreaterThanOrEqual(Math.max(c.movement, c.leave_one_out));
        expect(c.any).toBeLessThanOrEqual(c.movement + c.leave_one_out);
      }
    }
    // More sessions spread movement and the score over more of them.
    expect(results[3].none.movement).toBeLessThanOrEqual(results[0].none.movement);
    expect(results[3].none.fewSessions).toBeLessThanOrEqual(results[0].none.fewSessions);
    // Why F2 left the warning: with no link it fired in nearly every 90-day data set.
    expect(results[1].none.fewSessions / 200).toBeGreaterThan(0.9);
  }, SIMULATION_TIMEOUT);
});
