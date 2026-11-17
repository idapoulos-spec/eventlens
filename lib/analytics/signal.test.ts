import { describe, expect, it } from "vitest";
import { computeChanges, type ChangePoint } from "./changes";
import { lagTestFrame, primaryFrame } from "./correlation-test";
import { calibrationFor, type EvidenceRating } from "./evidence";
import { fragility, lagFragility, type Fragility, type LeaveOneOut } from "./fragility";
import type { TestResult } from "./inference";
import { crossCorrelation, type LagCorrelation } from "./lead-lag";
import { adjustedChanges, benchmarkReturnsByT, fitMarketModel } from "./market-model";
import { HOUR_MS } from "./probability";
import {
  closeOnDateOf,
  leadFlips,
  leadOf,
  leadWithoutSteps,
  pendingSlots,
  recentMove,
  shownMove,
  signalCheck,
  signalDecision,
  type SignalCheck,
  type SignalInput,
} from "./signal";
import { drain } from "./steps";
import { lastSessions, simulateMarketRows } from "./test-helpers";

const DRAWS = 199;

// ---- Hand-made results for the rules ----

function test(over: Partial<TestResult> = {}): TestResult {
  return {
    estimate: 0.2,
    ci: [0.05, 0.35],
    p: 0.01,
    holm: 0.06,
    bh: 0.03,
    role: "exploratory",
    family: "lead_lag",
    method: "wild_bootstrap",
    interval: "wild_bootstrap",
    resampling: null,
    n: 300,
    nEffective: 280,
    pUnavailable: null,
    ciUnavailable: null,
    ...over,
  };
}

const quiet = (over: Partial<TestResult> = {}) => test({ estimate: 0.01, ci: [-0.1, 0.12], p: 0.6, holm: 1, bh: 0.9, ...over });

/** The hourly family −3…3 with lag 0 as the primary test; `passing` maps a lag to its test. */
function family(passing: Record<number, Partial<TestResult>> = {}): LagCorrelation[] {
  return [-3, -2, -1, 0, 1, 2, 3].map((lag) => ({
    lag,
    n: 300,
    r: 0,
    rSquared: 0,
    kalshiMoves: 50,
    test: lag === 0 ? quiet({ role: "primary", family: null, holm: null, bh: null }) : lag in passing ? test(passing[lag]) : quiet(),
  })) as unknown as LagCorrelation[];
}

const stable: SignalCheck = {
  fragility: { movement: { effective: 25 } } as Fragility,
  leaveOneOut: { flips: 0, runs: [] } as unknown as LeaveOneOut,
};

// 13:00 New York (EST) on Wednesday 2026-01-07: a lead of up to 3 hours can still play out that day.
const ONE_PM = Date.UTC(2026, 0, 7, 18);
const at = (t: number) => ({ t, step: Math.round(t / HOUR_MS) });
const change = (t: number, kalshiChange: number): ChangePoint => ({ ...at(t), kalshiChange, logReturn: 0 });

function input(over: Partial<SignalInput> = {}): SignalInput {
  return {
    lags: family({ 1: {} }),
    card: "moderate",
    check: stable,
    calibration: calibrationFor("hourly", 90, false),
    changes: [change(ONE_PM, 3)],
    end: at(ONE_PM),
    resolution: "hourly",
    threshold: 2,
    ...over,
  };
}

describe("the signal's rules, in order", () => {
  it("S1: no market-adjusted lags", () => {
    expect(signalDecision(input({ lags: null }))).toMatchObject({ label: "hold", rule: "no_adjusted", level: "none" });
  });

  it("S2: no lag in the family has a p-value", () => {
    const lags = family().map((l) => ({ ...l, test: { ...l.test, p: null, bh: null, holm: null } }));
    expect(signalDecision(input({ lags }))).toMatchObject({ rule: "no_p", level: "not_enough_data", first: "untested" });
  });

  it("S3: no Kalshi-first lag passes BH (a raw p under 0.05 isn't enough)", () => {
    expect(signalDecision(input({ lags: family() }))).toMatchObject({ rule: "no_lead", level: "no_clear_lead", first: "neither" });
    expect(signalDecision(input({ lags: family({ 2: { p: 0.01, bh: 0.06 } }) }))).toMatchObject({ rule: "no_lead" });
    expect(signalDecision(input({ lags: family({ [-1]: {} }) }))).toMatchObject({ rule: "no_lead", first: "stock" });
  });

  it("S4: a stock-first lag passes too", () => {
    expect(signalDecision(input({ lags: family({ 1: {}, [-2]: {} }) }))).toMatchObject({ rule: "both_ways", level: "no_clear_lead", first: "both" });
  });

  it("S5: the lead's check or the card's rating is still computing", () => {
    expect(signalDecision(input({ check: undefined }))).toMatchObject({ label: "pending", rule: "pending", level: "pending" });
    expect(signalDecision(input({ card: "pending" }))).toMatchObject({ label: "pending", rule: "pending" });
  });

  it("S6: the lead is rated Weak: fragile (F1, F3, or a check that couldn't run) or without a range", () => {
    const weak = { rule: "weak_lead", level: "weak", label: "hold" };
    expect(signalDecision(input({ check: null }))).toMatchObject(weak);
    expect(signalDecision(input({ check: { ...stable, fragility: { movement: { effective: 9.9 } } as Fragility } }))).toMatchObject(weak);
    expect(signalDecision(input({ check: { ...stable, leaveOneOut: { flips: 1, runs: [] } as unknown as LeaveOneOut } }))).toMatchObject(weak);
    expect(signalDecision(input({ check: { ...stable, leaveOneOut: null } }))).toMatchObject(weak);
    expect(signalDecision(input({ lags: family({ 1: { ci: null } }) }))).toMatchObject(weak);
  });

  it("S7: the card's badge below Moderate holds, at the badge's level", () => {
    for (const card of ["weak", "no_clear_link", "not_enough_data"] as EvidenceRating["level"][]) {
      expect(signalDecision(input({ card }))).toMatchObject({ rule: "badge", level: card, label: "hold" });
    }
  });

  it("S8: hourly, a lead that can't play out by 4 PM holds", () => {
    const fourPm = ONE_PM + 3 * HOUR_MS;
    expect(signalDecision(input({ end: at(fourPm), changes: [change(fourPm, 5)] }))).toMatchObject({ rule: "too_late", level: "moderate", move: { slots: 0 } });
    // At 3 PM a 1-hour lead still plays out at 4 PM, a 2-hour one doesn't.
    const threePm = ONE_PM + 2 * HOUR_MS;
    expect(signalDecision(input({ end: at(threePm), changes: [change(threePm, 3)] }))).toMatchObject({ rule: "lean", label: "buy" });
    expect(signalDecision(input({ lags: family({ 2: {} }), end: at(threePm), changes: [change(threePm, 3)] }))).toMatchObject({ rule: "no_move", move: { slots: 1, value: 0 } });
  });

  it("S9: a recent move smaller than the jump size, as shown, holds", () => {
    expect(signalDecision(input({ changes: [change(ONE_PM, 1.94)] }))).toMatchObject({ rule: "no_move", move: { value: 1.9, enough: false } });
    expect(signalDecision(input({ changes: [change(ONE_PM, 1.96)] }))).toMatchObject({ rule: "lean", move: { value: 2, enough: true } });
    expect(signalDecision(input({ changes: [] }))).toMatchObject({ rule: "no_move", move: { value: 0 } });
  });

  it("S10: direction is the lead's sign times the recent move's", () => {
    const cases: [number, number, "buy" | "sell"][] = [
      [0.2, 3, "buy"],
      [0.2, -3, "sell"],
      [-0.2, 3, "sell"],
      [-0.2, -3, "buy"],
    ];
    for (const [r, move, label] of cases) {
      const lags = family({ 1: { estimate: r, ci: r > 0 ? [0.05, 0.35] : [-0.35, -0.05] } });
      expect(signalDecision(input({ lags, changes: [change(ONE_PM, move)] })), `${r}, ${move}`).toMatchObject({ rule: "lean", label, level: "moderate" });
    }
  });

  it("is never stronger than the card's badge, and Strong needs BH p < 0.005 outside long daily windows", () => {
    const strongLead = family({ 1: { p: 0.001, bh: 0.004 } });
    expect(signalDecision(input({ lags: strongLead, card: "strong" })).level).toBe("strong");
    expect(signalDecision(input({ lags: strongLead, card: "moderate" })).level).toBe("moderate");
    expect(signalDecision(input({ card: "strong" })).level).toBe("moderate");
    expect(signalDecision(input({ lags: strongLead, card: "strong", calibration: calibrationFor("daily", 180, true), resolution: "daily", end: { t: 0, step: 40 }, changes: [{ t: 0, step: 40, kalshiChange: 3, logReturn: 0 }] })).level).toBe("moderate");
  });

  it("uses only the lead the tile names: the smallest p among passing Kalshi-first lags, ties to the shorter", () => {
    expect(leadOf(family({ 1: { p: 0.02 }, 3: { p: 0.004 } })).kalshiFirst!.lag).toBe(3);
    expect(leadOf(family({ 1: { p: 0.004 }, 2: { p: 0.004 } })).kalshiFirst!.lag).toBe(1);
    // A fragile lead holds; no other lag is tried.
    const lags = family({ 1: { p: 0.004, ci: null }, 2: { p: 0.01 } });
    expect(signalDecision(input({ lags }))).toMatchObject({ rule: "weak_lead", lead: { lag: 1 } });
  });
});

describe("pending intervals and the recent move", () => {
  const step = (t: number) => Math.round(t / HOUR_MS);

  it("counts the window's last k slots whose partner hour ends by 4 PM New York, in winter and summer time", () => {
    expect(closeOnDateOf(ONE_PM)).toBe(Date.UTC(2026, 0, 7, 21));
    expect(pendingSlots(at(ONE_PM), 3, "hourly")).toEqual([step(ONE_PM) - 2, step(ONE_PM) - 1, step(ONE_PM)]);
    expect(pendingSlots(at(ONE_PM + 2 * HOUR_MS), 3, "hourly")).toEqual([step(ONE_PM)]);
    expect(pendingSlots(at(ONE_PM + 3 * HOUR_MS), 1, "hourly")).toEqual([]);
    // July: New York is UTC−4, so 1 PM is 17:00 UTC and the close 20:00 UTC.
    const julyOnePm = Date.UTC(2026, 6, 8, 17);
    expect(closeOnDateOf(julyOnePm)).toBe(Date.UTC(2026, 6, 8, 20));
    expect(pendingSlots(at(julyOnePm + 2 * HOUR_MS), 1, "hourly")).toEqual([step(julyOnePm) + 2]);
    expect(pendingSlots(at(julyOnePm + 3 * HOUR_MS), 1, "hourly")).toEqual([]);
  });

  it("counts every one of the last k trading days, daily", () => {
    expect(pendingSlots({ t: 0, step: 50 }, 2, "daily")).toEqual([49, 50]);
  });

  it("sums the usable changes in them, shown to one decimal, with no negative zero", () => {
    const changes = [change(ONE_PM - 3 * HOUR_MS, 9), change(ONE_PM - HOUR_MS, 1.2), change(ONE_PM, 1.3)];
    expect(recentMove(changes, at(ONE_PM), 2, "hourly", 2)).toEqual({ lag: 2, slots: 2, value: 2.5, enough: true });
    expect(recentMove(changes, at(ONE_PM), 1, "hourly", 2)).toEqual({ lag: 1, slots: 1, value: 1.3, enough: false });
    expect(Object.is(shownMove(-0.04), 0)).toBe(true);
    // An event's jump size of 0.25 bp: 0.24 shows as 0.2 (short), 0.25 as 0.3.
    expect(recentMove([change(ONE_PM, 0.24)], at(ONE_PM), 1, "hourly", 0.25).enough).toBe(false);
    expect(recentMove([change(ONE_PM, 0.25)], at(ONE_PM), 1, "hourly", 0.25).enough).toBe(true);
  });
});

describe("the lead's leave-one-out check", () => {
  it("flips on the BH decision or a passing lead's sign, and a rerun without a p-value decides nothing", () => {
    const lead = test();
    expect(leadFlips(lead, test({ bh: 0.04 }))).toBe(false);
    expect(leadFlips(lead, test({ p: 0.01, bh: 0.051 }))).toBe(true);
    expect(leadFlips(lead, test({ estimate: -0.1 }))).toBe(true);
    expect(leadFlips(lead, test({ p: null, bh: null }))).toBe(false);
  });

  // One simulated analysis where the stock follows Kalshi an hour later.
  const { rows: full, closesByT } = simulateMarketRows({ sessions: 62, resolution: "hourly", seed: 906, sharedVolatility: true, kalshiInMarket: 0.1, lagEffect: { lag: 1, effect: 0.3 } });
  const changes = computeChanges(lastSessions(full, 62, "hourly"), 100).changes;
  const model = fitMarketModel(full, closesByT)!;
  const abnormal = adjustedChanges(changes, benchmarkReturnsByT(full, closesByT), model);
  const lags = crossCorrelation(abnormal, 3, "hourly", { primaryLag: 0, refit: model.sample, draws: DRAWS });
  const lead = lags.find((l) => l.lag === 1)!;

  it("finds the lead the simulation built in", () => {
    expect(leadOf(lags)).toMatchObject({ first: "kalshi", kalshiFirst: { lag: 1 } });
  });

  it("reruns the whole family: dropping nothing gives the page's test exactly", () => {
    const f = lagFragility(abnormal, model, "hourly", 1)!;
    const rerun = drain(leadWithoutSteps({ full, closesByT, changes, resolution: "hourly", lag: 1, maxLag: 3, draws: DRAWS }, f.blocking, new Set()));
    expect(rerun).toEqual(lead.test);
  });

  it("ranks the lead's own sessions and reruns without each of the top 10, then all of them", () => {
    const check = signalCheck({ full, closesByT, changes, abnormal, model, resolution: "hourly", lag: 1, lead: lead.test, maxLag: 3, draws: DRAWS });
    expect(check.fragility!.sessions.ranked).toHaveLength(10);
    expect(check.leaveOneOut!.runs.map((r) => r.rank)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    expect(check.leaveOneOut!.flips).toBe(check.leaveOneOut!.runs.filter((r) => leadFlips(lead.test, r.test)).length);
    // Each rerun is the family without that session, as computed directly.
    const first = check.leaveOneOut!.runs[0];
    const direct = drain(leadWithoutSteps({ full, closesByT, changes, resolution: "hourly", lag: 1, maxLag: 3, draws: DRAWS }, check.fragility!.blocking, new Set([first.session.key])));
    expect(first.test).toEqual(direct);
  });
});

describe("a lag's diagnostics", () => {
  const { rows: full, closesByT } = simulateMarketRows({ sessions: 62, resolution: "hourly", seed: 900, sharedVolatility: true, kalshiInMarket: 0.1 });
  const changes = computeChanges(full, 100).changes;
  const model = fitMarketModel(full, closesByT)!;
  const abnormal = adjustedChanges(changes, benchmarkReturnsByT(full, closesByT), model);

  it("are fragility()'s at lag 0, from the same frame", () => {
    expect(lagFragility(abnormal, model, "hourly", 0)).toEqual(fragility(abnormal, model, "hourly"));
    const lf = lagTestFrame(abnormal, "hourly", model.sample, 0)!;
    const pf = primaryFrame(abnormal, "hourly", model.sample)!;
    expect(lf.f).toEqual(pf.f);
    expect(lf.kalshi).toEqual(pf.sorted);
  });

  it("count a lag's own pairs: an hourly lag of 3 pairs 3 of each session's 6 intervals", () => {
    const f3 = lagFragility(abnormal, model, "hourly", 3)!;
    expect(f3.movement.intervals).toBe(62 * 3);
    expect(f3.hours.every((h) => new Date(h.t).getUTCHours() <= 18)).toBe(true);
  });
});

describe("the simulator's opt-in lead and jump", () => {
  const base = { sessions: 5, resolution: "hourly", seed: 4_242, sharedVolatility: true, kalshiInMarket: 0.1 } as const;
  const plain = simulateMarketRows(base);

  it("change nothing when off or zero", () => {
    expect(simulateMarketRows({ ...base, lagEffect: { lag: 1, effect: 0 } })).toEqual(plain);
  });

  it("a lagged effect moves only the stock, from the session's second interval on", () => {
    const lagged = simulateMarketRows({ ...base, lagEffect: { lag: 1, effect: 0.3 } });
    expect(lagged.rows.map((r) => r.kalshiValue)).toEqual(plain.rows.map((r) => r.kalshiValue));
    expect([...lagged.closesByT]).toEqual([...plain.closesByT]);
    // The first two rows of the first session (10:00 and 11:00) can't have a lagged effect yet.
    expect(lagged.rows.slice(0, 2)).toEqual(plain.rows.slice(0, 2));
    expect(lagged.rows.map((r) => r.stockClose)).not.toEqual(plain.rows.map((r) => r.stockClose));
  });

  it("a last-session jump sets that interval's Kalshi change, leaving every earlier session as it was", () => {
    const jumped = simulateMarketRows({ ...base, lastSessionJump: { interval: 2, pp: -3 } });
    expect(jumped.rows.slice(0, -7)).toEqual(plain.rows.slice(0, -7));
    const last = jumped.rows.slice(-7);
    // Interval 2 ends at 13:00, the last session's fourth row.
    expect((last[3].kalshiValue! - last[2].kalshiValue!) * 100).toBeCloseTo(-3, 9);
  });
});
