import { describe, expect, it } from "vitest";
import { calibrationFor, evidenceRating } from "./evidence";
import type { LeaveOneOut } from "./fragility";
import type { DetectableCorrelation } from "./correlation-test";
import { panelCore, secondarySignalCheckSteps, type PanelInput } from "./panel";
import { panelRunner, runJob } from "./panel-jobs";
import { rateSummary } from "./scan-sim";
import { signalDecision, type SignalRule } from "./signal";
import { SIGNAL_SIM, signalDataSet, simulateSignal, type SignalSimOptions } from "./signal-sim";
import { drain } from "./steps";

// How often the experimental signal (signal.ts) shows Leans Buy or Leans Sell, with no relationship
// and with real ones. The design, seeds, data sets, and the bar were written into the README
// ("Checking the signal by simulation") before this file first ran; each setting runs once. Every
// data set is the worst case for a false signal: its window ends at 1:00 PM New York, right after
// Kalshi moved 3 pp (signal-sim.ts). The lead-lag family, the primary test, and the leave-one-out
// checks run at the page's 999 draws, and only what the rules need to decide the label is computed.

// Simulations run hundreds of analyses; allow for slow CI machines.
const SIMULATION_TIMEOUT = 2_400_000;
const NULL_SETS = 500;
// Cut from 200 before the run, as the README allows: at 200, timing put the CI job near its 60-minute limit.
const LINK_SETS = 100;
const BAR = 0.05;
const RULES: SignalRule[] = ["no_adjusted", "no_p", "no_lead", "both_ways", "pending", "weak_lead", "badge", "too_late", "no_move", "lean"];
const WINDOWS = [
  { window: 21, days: 30 },
  { window: 62, days: 90 },
  { window: 124, days: 180 },
] as const;

interface Tally {
  sets: number;
  rules: Record<SignalRule, number>;
  buy: number;
  sell: number;
  /** Labels pointing the way Kalshi's last jump went (with a positive link, the way the link implies). */
  withJump: number;
  /** Labels whose stock then moved that way against the benchmark over the lead's next k hours. */
  followed: number;
  ms: number;
}

function tally(options: Omit<SignalSimOptions, "seed">, first: number, sets: number): Tally {
  const start = performance.now();
  const t: Tally = { sets, rules: Object.fromEntries(RULES.map((r) => [r, 0])) as Record<SignalRule, number>, buy: 0, sell: 0, withJump: 0, followed: 0, ms: 0 };
  for (let i = 0; i < sets; i++) {
    const { decision, jumpSign, realized } = simulateSignal({ ...options, seed: first + i });
    t.rules[decision.rule]++;
    if (decision.label !== "buy" && decision.label !== "sell") continue;
    const direction = decision.label === "buy" ? 1 : -1;
    t[decision.label]++;
    if (direction === jumpSign) t.withJump++;
    if (Math.sign(realized!) === direction) t.followed++;
  }
  t.ms = performance.now() - start;
  return t;
}

const pct = (count: number, n: number) => {
  if (n === 0) return "— (0 of 0)";
  const s = rateSummary(count, n);
  return `${(s.rate * 100).toFixed(1)}% (${count} of ${n}) ± ${(s.se * 100).toFixed(1)}, range ${(s.lo * 100).toFixed(1)}–${(s.hi * 100).toFixed(1)}%`;
};

function report(label: string, t: Tally) {
  const labels = t.buy + t.sell;
  console.log(
    [
      `${label}: ${t.sets} data sets, ${(t.ms / 1000).toFixed(0)} s`,
      ...RULES.map((r) => `  ${r}: ${pct(t.rules[r], t.sets)}`),
      `  Leans Buy or Sell: ${pct(labels, t.sets)} (Buy ${t.buy}, Sell ${t.sell})`,
      `  pointing the way of Kalshi's last jump: ${pct(t.withJump, labels)}`,
      `  stock then moved that way against the benchmark: ${pct(t.followed, labels)}`,
    ].join("\n"),
  );
}

/** The same data set through the panel's own functions and its signal job, as the page runs them. */
function signalThroughPanel(options: SignalSimOptions) {
  const days = options.window === 21 ? 30 : options.window === 62 ? 90 : 180;
  const { full, windowRows, closesByT } = signalDataSet(options);
  const input: PanelInput = {
    full,
    from: windowRows[0].t - 1,
    resolution: "hourly",
    scale: 100,
    closes: [...closesByT].map(([t, value]) => ({ t, value })),
    returns: "adjusted",
  };
  const core = panelCore(input);
  let detectable: DetectableCorrelation | null | undefined;
  let loo: LeaveOneOut | null | undefined;
  runJob(panelRunner(), { kind: "secondary", key: "s", coreKey: "s", input }, (m) => {
    if (m.kind === "detectable") detectable = m.value;
    if (m.kind === "leave_one_out") loo = m.value;
  });
  const calibration = calibrationFor("hourly", days, days > 90);
  const card = evidenceRating({ primary: core.market!.primary, fragility: core.fragility, leaveOneOut: loo, detectable, calibration }).level;
  const base = { lags: core.lags, card, calibration, changes: core.market!.abnormal!, end: core.rows[core.rows.length - 1], resolution: "hourly" as const, threshold: SIGNAL_SIM.threshold };
  const first = signalDecision({ ...base, check: undefined });
  if (first.rule !== "pending") return first;
  const check = drain(secondarySignalCheckSteps(input, core, first.lead!.lag, first.lead!.test));
  return signalDecision({ ...base, check });
}

describe("simulations: how often the experimental signal shows Leans Buy or Leans Sell", () => {
  it("gets a data set's signal exactly as the panel's own functions do", () => {
    for (const { window } of WINDOWS) {
      for (const options of [
        { window, seed: 7_300_000 + 10_000 * WINDOWS.findIndex((w) => w.window === window) },
        { window, seed: 7_400_000 + 10_000 * WINDOWS.findIndex((w) => w.window === window), lead: 0.3 },
      ]) {
        const { label, rule } = simulateSignal(options).decision;
        expect(signalThroughPanel(options), JSON.stringify(options)).toMatchObject({ label, rule });
      }
    }
  }, SIMULATION_TIMEOUT);

  // With no relationship: the bar set beforehand (README).
  for (const [i, { window, days }] of WINDOWS.entries()) {
    it(`with no relationship, ${days} days: Leans Buy or Sell in at most ${BAR * 100}% of data sets`, () => {
      const t = tally({ window }, 7_300_000 + 10_000 * i, NULL_SETS);
      report(`No relationship, ${days} days`, t);
      expect(t.rules.no_adjusted + t.rules.pending).toBe(0);
      expect(t.buy + t.sell).toBeLessThanOrEqual(BAR * NULL_SETS);
    }, SIMULATION_TIMEOUT);
  }

  // With real links: reported, without a bar.
  for (const [i, { window, days }] of WINDOWS.entries()) {
    it(`with Kalshi first only (0.3% per pp an hour later), ${days} days: reported`, () => {
      const t = tally({ window, lead: 0.3 }, 7_400_000 + 10_000 * i, LINK_SETS);
      report(`Kalshi first only, ${days} days`, t);
      expect(t.rules.no_adjusted + t.rules.pending).toBe(0);
    }, SIMULATION_TIMEOUT);
  }

  it("with the same lead plus a same-hour link (0.3% per pp each), 90 days: reported", () => {
    const t = tally({ window: 62, lead: 0.3, effect: 0.3 }, 7_500_000, LINK_SETS);
    report("Kalshi first and the same hour, 90 days", t);
    expect(t.rules.no_adjusted + t.rules.pending).toBe(0);
  }, SIMULATION_TIMEOUT);

  it("with a same-hour link only (0.3% per pp), 90 days: reported", () => {
    const t = tally({ window: 62, effect: 0.3 }, 7_600_000, LINK_SETS);
    report("Same hour only, 90 days", t);
    expect(t.rules.no_adjusted + t.rules.pending).toBe(0);
  }, SIMULATION_TIMEOUT);
});
