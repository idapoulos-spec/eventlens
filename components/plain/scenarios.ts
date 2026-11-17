// Every wording path of the bottom-line summary, for the language and wording tests: each rating
// rule for a market and an event at several settings, and a scan's summary in each state. Built from
// real panel results (simulated rows) with the parts each rule reads swapped for hand-made ones.

import type { TestResult } from "@/lib/analytics";
import type { Correction } from "@/lib/analytics/scan";
import type { Fragility, LeaveOneOut } from "@/lib/analytics/fragility";
import type { PanelResults } from "@/lib/analytics/panel";
import type { WindowChoice } from "@/lib/history/window";
import type { ScanCandidate } from "@/lib/scan/types";
import type { CandidateState, ScanSnapshot } from "../scan/scanRunner";
import { bottomLine, scanBottomLine, type BottomLineInput, type BottomLine } from "./summary";
import { detectableAt, EVENT, fragilityWith, looWith, MARKET, bottomLineInput, primaryWith, simulated, withParts } from "./test-helpers";

export interface Scenario {
  name: string;
  summary: BottomLine;
  input?: BottomLineInput;
}

let cache: { results: ReturnType<typeof simulated>["results"]; loo: LeaveOneOut } | null = null;

/** One simulated 90-day window, computed once: every scenario swaps parts of it. */
export function base() {
  if (!cache) {
    const { results, loo } = simulated();
    cache = { results, loo: loo! };
  }
  return cache;
}

/** The parts each rule reads, for one rule. */
function rule(name: string): { primary: Partial<TestResult>; fragility?: number | null; loo?: number | null | undefined; detectable?: number | null | "missing" | undefined } {
  switch (name) {
    case "no_p":
      return { primary: { p: null, ci: null, pUnavailable: "too_few_blocks", ciUnavailable: "too_few_blocks" }, loo: undefined, detectable: undefined };
    case "pending_significant":
      return { primary: { p: 0.01, estimate: 0.2, ci: [0.05, 0.33] }, loo: undefined };
    case "pending_not_significant":
      return { primary: { p: 0.4, estimate: 0.05, ci: [-0.1, 0.2] }, detectable: undefined, loo: undefined };
    case "few_moves":
      return { primary: { p: 0.41, estimate: 0.09, ci: [-0.22, 0.41] }, fragility: 6.3, loo: 0, detectable: 0.6 };
    case "low_power":
      return { primary: { p: 0.41, estimate: 0.09, ci: [-0.12, 0.3] }, loo: 0, detectable: 0.35 };
    case "low_power_capped":
      return { primary: { p: 0.41, estimate: 0.09, ci: [-0.5, 0.6] }, loo: 0, detectable: null };
    case "low_power_missing":
      return { primary: { p: 0.41, estimate: 0.09, ci: [-0.12, 0.3] }, loo: 0, detectable: "missing" };
    case "no_link":
      return { primary: { p: 0.58, estimate: 0.02, ci: [-0.05, 0.09] }, loo: 0, detectable: 0.18 };
    case "fragile_loo":
      return { primary: { p: 0.034, estimate: 0.07, ci: [0.01, 0.18] }, loo: 2 };
    case "fragile_both":
      return { primary: { p: 0.012, estimate: -0.24, ci: [-0.4, -0.06] }, fragility: 7.4, loo: 1 };
    case "fragile_unchecked":
      return { primary: { p: 0.02, estimate: 0.3, ci: [0.05, 0.5] }, loo: null };
    case "no_interval":
      return { primary: { p: 0.03, estimate: 0.15, ci: null, ciUnavailable: "unstable" }, loo: 0 };
    case "strong":
      return { primary: { p: 0.001, estimate: -0.21, ci: [-0.28, -0.14] }, loo: 0 };
    case "strong_small":
      return { primary: { p: 0.002, estimate: 0.08, ci: [0.03, 0.13] }, loo: 0 };
    case "moderate":
      return { primary: { p: 0.02, estimate: 0.35, ci: [0.06, 0.55] }, loo: 0 };
    case "moderate_small":
      return { primary: { p: 0.03, estimate: -0.06, ci: [-0.11, -0.01] }, loo: 0 };
  }
  throw new Error(name);
}

export const RULES = [
  "no_p",
  "pending_significant",
  "pending_not_significant",
  "few_moves",
  "low_power",
  "low_power_capped",
  "low_power_missing",
  "no_link",
  "fragile_loo",
  "fragile_both",
  "fragile_unchecked",
  "no_interval",
  "strong",
  "strong_small",
  "moderate",
  "moderate_small",
] as const;

/** The plain input for one rule, at one setting. */
export function ruleInput(name: (typeof RULES)[number], over: Partial<BottomLineInput> = {}): BottomLineInput {
  const { results, loo } = base();
  const r = rule(name);
  const f = results.fragility!;
  const fragility: Fragility | null = r.fragility === null ? null : r.fragility === undefined ? fragilityWith(f, Math.max(12, f.movement.effective)) : fragilityWith(f, r.fragility);
  const primary = primaryWith(results.market!.primary!, r.primary);
  return bottomLineInput(withParts(results, { primary, fragility }), {
    leaveOneOut: r.loo === undefined ? undefined : r.loo === null ? null : looWith(loo, r.loo),
    detectable: r.detectable === undefined ? (primary.p !== null && primary.p >= 0.05 ? undefined : null) : r.detectable === "missing" ? null : detectableAt(r.detectable),
    ...over,
  });
}

const SETTINGS: { name: string; over: Partial<BottomLineInput> }[] = [
  { name: "90D hourly", over: {} },
  { name: "30D hourly", over: { choice: 30 as WindowChoice } },
  { name: "30D daily", over: { choice: 30 as WindowChoice, resolution: "daily" } },
  { name: "1Y daily", over: { choice: 365 as WindowChoice, resolution: "daily", longDaily: true } },
  { name: "All hourly, stored, frozen", over: { choice: "all" as WindowChoice, sources: { provenance: { storedThrough: 1, liveFrom: 2, liveFailed: false } }, frozenAt: 3 } },
  { name: "7D hourly, closed, window note", over: { choice: 7 as WindowChoice, windowEnd: 5, windowNote: "This market opened on Oct 1, 2026, so the 7D window covers only 6 days." } },
];

/** Every analysis wording path: each rule × market and event × setting, plus no primary test and raw returns. */
export function analysisScenarios(): Scenario[] {
  const out: Scenario[] = [];
  for (const variable of [MARKET, EVENT]) {
    for (const setting of SETTINGS) {
      for (const name of RULES) {
        const input = ruleInput(name, { variable, ...setting.over });
        out.push({ name: `${variable.kind} ${setting.name} ${name}`, summary: bottomLine(input), input });
      }
    }
    for (const unavailable of ["TLT is the benchmark itself", "Loading the benchmark", "Benchmark prices aren’t available"]) {
      const { results } = base();
      const input = bottomLineInput({ ...results, market: { ...results.market!, primary: null, kalshi: null } }, { variable, unavailable, detectable: null, leaveOneOut: null });
      out.push({ name: `${variable.kind} no primary: ${unavailable}`, summary: bottomLine(input), input });
    }
  }
  const raw = simulated({ returns: "raw" });
  const input = bottomLineInput(raw.results, { leaveOneOut: raw.loo, detectable: detectableAt(0.25) });
  out.push({ name: "market raw returns", summary: bottomLine(input), input });
  for (const variable of [MARKET, EVENT]) {
    for (const c of GAUGE_CASES) {
      const input = gaugeInput(c, { variable });
      out.push({ name: `${variable.kind} gauge: ${c.name}`, summary: bottomLine(input), input });
    }
  }
  return out;
}

/**
 * Cases for the gauge, added after the ones above (which stay as they were): a rule's setup with r
 * and its range swapped, keeping the rule's p, so a range excludes zero exactly when p < 0.05, as the
 * main test's does.
 */
export const GAUGE_CASES: { name: string; rule: (typeof RULES)[number]; primary: Partial<TestResult> }[] = [
  { name: "r and range past +0.5", rule: "moderate", primary: { estimate: 0.62, ci: [0.31, 0.84] } },
  { name: "r and range past −0.5", rule: "strong", primary: { estimate: -0.58, ci: [-0.77, -0.33] } },
  { name: "range past both ends", rule: "low_power_capped", primary: { estimate: -0.04, ci: [-0.71, 0.66] } },
  { name: "opposite, range crossing zero", rule: "no_link", primary: { estimate: -0.03, ci: [-0.09, 0.04] } },
  { name: "clearly together, range crossing zero", rule: "low_power", primary: { estimate: 0.34, ci: [-0.04, 0.63] } },
  { name: "range ending at zero", rule: "no_link", primary: { estimate: 0.05, ci: [0, 0.1] } },
  { name: "r exactly zero", rule: "no_link", primary: { estimate: 0, ci: [-0.07, 0.07] } },
  { name: "no range, not rated", rule: "no_p", primary: { estimate: -0.12 } },
  { name: "no correlation", rule: "no_p", primary: { estimate: null } },
];

/** One gauge case's input, at one setting. */
export function gaugeInput(c: (typeof GAUGE_CASES)[number], over: Partial<BottomLineInput> = {}): BottomLineInput {
  const input = ruleInput(c.rule, over);
  const primary = primaryWith(input.results.market!.primary!, c.primary);
  return { ...input, results: withParts(input.results, { primary }) };
}

// ---- The experimental signal ----

/** How the signal's paths set up the lead-lag family, the window's end, and the lead's check. */
type LagSetup = "none_tested" | "no_lead" | "both_ways" | "lead" | "lead_small" | "lead_strong" | "lead_no_range" | "lead_negative";
type CheckSetup = "stable" | "fragile_loo" | "fragile_moves" | "unchecked" | "pending";
type EndSetup = "in_session" | "late" | "quiet" | "falling";

/** Each signal path: the card's rule (its badge), the lags, the lead's check, and the window's end. */
export const SIGNAL_PATHS: Record<string, { card: (typeof RULES)[number]; lags: LagSetup; check?: CheckSetup; end?: EndSetup }> = {
  "signal: no lag tested": { card: "no_p", lags: "none_tested" },
  "signal: Kalshi doesn't move first": { card: "moderate", lags: "no_lead" },
  "signal: both ways": { card: "moderate", lags: "both_ways" },
  "signal: checking the lead": { card: "moderate", lags: "lead", check: "pending" },
  "signal: waiting for the card": { card: "pending_significant", lags: "lead", check: "stable" },
  "signal: fragile lead (F3)": { card: "moderate", lags: "lead", check: "fragile_loo" },
  "signal: fragile lead (F1)": { card: "moderate", lags: "lead", check: "fragile_moves" },
  "signal: lead check couldn't run": { card: "moderate", lags: "lead", check: "unchecked" },
  "signal: lead without a range": { card: "moderate", lags: "lead_no_range", check: "stable" },
  "signal: badge Weak": { card: "fragile_loo", lags: "lead", check: "stable" },
  "signal: badge No clear link": { card: "no_link", lags: "lead", check: "stable" },
  "signal: badge Not enough data": { card: "low_power", lags: "lead", check: "stable" },
  "signal: too late in the day": { card: "moderate", lags: "lead", check: "stable", end: "late" },
  "signal: no recent move": { card: "moderate", lags: "lead", check: "stable", end: "quiet" },
  "signal: leans up": { card: "moderate", lags: "lead", check: "stable" },
  "signal: leans down, Kalshi falling": { card: "moderate", lags: "lead", check: "stable", end: "falling" },
  "signal: leans down, opposite lead": { card: "strong", lags: "lead_negative", check: "stable" },
  "signal: leans, small lead": { card: "moderate", lags: "lead_small", check: "stable" },
  "signal: leans, strong lead capped at the badge": { card: "moderate", lags: "lead_strong", check: "stable" },
  "signal: leans, strong": { card: "strong", lags: "lead_strong", check: "stable" },
};

const NY_HOUR = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", hour: "numeric", hourCycle: "h23" });

/** The family −3…3 with tests swapped: a Kalshi-first lead at +2 (or none), and others quiet. */
function lagsWith(lags: PanelResults["view"]["lags"], setup: LagSetup): PanelResults["view"]["lags"] {
  const quiet = (t: TestResult): TestResult => ({ ...t, p: 0.5, holm: 1, bh: 0.8, estimate: 0.02, ci: [-0.08, 0.12] });
  const passing = (t: TestResult, over: Partial<TestResult> = {}): TestResult => ({ ...t, p: 0.004, holm: 0.024, bh: 0.024, estimate: 0.18, ci: [0.06, 0.3], ...over });
  return lags.map((l) => {
    if (l.test.role !== "exploratory") return l;
    if (setup === "none_tested") return { ...l, test: { ...l.test, p: null, holm: null, bh: null, ci: null, pUnavailable: "too_few_blocks" } };
    const lead = l.lag === 2;
    const test =
      lead && setup !== "no_lead"
        ? passing(l.test, {
            ...(setup === "lead_small" && { estimate: 0.07, ci: [0.02, 0.12] }),
            ...(setup === "lead_strong" && { p: 0.001, bh: 0.003, holm: 0.004 }),
            ...(setup === "lead_no_range" && { ci: null, ciUnavailable: "unstable" }),
            ...(setup === "lead_negative" && { estimate: -0.22, ci: [-0.35, -0.08] }),
          })
        : setup === "both_ways" && l.lag === -1
          ? passing(l.test)
          : setup === "lead_strong" && l.lag === 1
            ? passing(l.test, { p: 0.001, bh: 0.003, holm: 0.004 })
            : quiet(l.test);
    return { ...l, test };
  });
}

/** The input for one signal path, at one setting. */
export function signalInput(path: keyof typeof SIGNAL_PATHS, over: Partial<BottomLineInput> = {}): BottomLineInput {
  const { card, lags, check = "stable", end = "in_session" } = SIGNAL_PATHS[path];
  const input = ruleInput(card, over);
  const { results } = input;
  const { loo } = base();
  // End the window at 1 PM New York (late: 4 PM) on its last day, right after a Kalshi move of 3 (quiet: 0.5).
  const hour = end === "late" ? 16 : 13;
  const rows = results.rows.slice(0, results.rows.findLastIndex((r) => Number(NY_HOUR.format(r.t)) === hour) + 1);
  const endT = rows[rows.length - 1].t;
  const move = end === "quiet" ? 0.5 : end === "falling" ? -3 : 3;
  const changes = results.view.changes.filter((c) => c.t <= endT).map((c) => (c.t === endT ? { ...c, kalshiChange: move } : c.t > endT - 2 * 3600_000 ? { ...c, kalshiChange: 0 } : c));
  const f = results.fragility!;
  const signalCheck: BottomLineInput["signalCheck"] =
    check === "pending"
      ? undefined
      : check === "unchecked"
        ? null
        : { fragility: fragilityWith(f, check === "fragile_moves" ? 6.1 : 24), leaveOneOut: looWith(loo, check === "fragile_loo" ? 2 : 0) };
  return {
    ...input,
    threshold: input.variable.kind === "probability" ? 2 : 0.5,
    signalCheck,
    results: { ...results, rows, view: { ...results.view, changes, lags: lagsWith(results.view.lags, lags) } },
  };
}

/** Every signal wording path × market and event × setting, plus Raw returns. */
export function signalScenarios(): Scenario[] {
  const out: Scenario[] = [];
  for (const variable of [MARKET, EVENT]) {
    for (const setting of SETTINGS) {
      for (const path of Object.keys(SIGNAL_PATHS)) {
        const input = signalInput(path, { variable, ...setting.over });
        out.push({ name: `${variable.kind} ${setting.name} ${path}`, summary: bottomLine(input), input });
      }
    }
    // Another benchmark, named in the label.
    const input = signalInput("signal: leans up", { variable, benchmark: "QQQ" });
    out.push({ name: `${variable.kind} signal: leans up vs. QQQ`, summary: bottomLine(input), input });
  }
  return out;
}

// ---- Scans ----

export const SCAN_CANDIDATES: ScanCandidate[] = [
  { ticker: "KXFEDDECISION-25DEC", kind: "event", event: "KXFEDDECISION-25DEC", series: "KXFEDDECISION", title: "Fed decision in Dec 2025", label: null, picked: null, end: 1, start: 0, stored: true },
  { ticker: "KXFEDDECISION-25OCT-H0", kind: "market", event: "KXFEDDECISION-25OCT", series: "KXFEDDECISION", title: "Fed decision in Oct 2025", label: "Fed maintains rate", picked: null, end: 1, start: 0, stored: true },
  { ticker: "KXFEDDECISION-25SEP", kind: "event", event: "KXFEDDECISION-25SEP", series: "KXFEDDECISION", title: "Will the Fed cut in Sep 2025?", label: null, picked: null, end: 1, start: 0, stored: true },
];

interface LeadSetup {
  bh: number;
  holm: number;
  p?: number;
  estimate?: number;
  ci?: [number, number] | null;
  effective?: number;
  loo?: Extract<CandidateState, { status: "done" }>["loo"];
  phase?: ScanSnapshot["phase"];
  leadIndex?: number;
  untested?: boolean;
  pending?: boolean;
}

/** A scan's snapshot: the lead (by rank) with these numbers, the others well behind it. */
export function scanSnap({ bh, holm, p = 0.0004, estimate = -0.21, ci = [-0.3, -0.12], effective = 25, loo, phase = "done", leadIndex = 0, untested = false, pending = false }: LeadSetup): ScanSnapshot {
  const { results, loo: baseLoo } = base();
  const primary = results.market!.primary!;
  const f = results.fragility!;
  const states: CandidateState[] = SCAN_CANDIDATES.map((_, i) => {
    if (i === leadIndex) {
      return {
        status: "done",
        test: { primary: primaryWith(primary, { p, estimate, ci, ciUnavailable: ci ? null : "unstable" }), fragility: fragilityWith(f, effective), refined: null, p },
        asOf: 0,
        sameAs90: false,
        loo: loo === undefined ? looWith(baseLoo, 0) : loo,
      };
    }
    if (untested && i === 2) return { status: "untested", reason: "Kalshi has no history in this window" };
    if (pending && i === 2) return { status: "loading" };
    return { status: "done", test: { primary: primaryWith(primary, { p: 0.4 + 0.1 * i, estimate: 0.02 }), fragility: f, refined: null, p: 0.4 + 0.1 * i }, asOf: 0, sameAs90: false, loo: null };
  });
  const corrections: (Correction | null)[] = states.map((s, i) =>
    s.status !== "done" ? null : i === leadIndex ? { holm, bh, survivesHolm: holm < 0.05, survivesBh: bh < 0.05 } : { holm: 1, bh: 0.9, survivesHolm: false, survivesBh: false },
  );
  const order = [leadIndex, ...states.map((_, i) => i).filter((i) => i !== leadIndex)];
  return {
    phase,
    error: null,
    states,
    corrections,
    order,
    prices: { requests: 2, fetchedAt: 0, benchmarkFetchedAt: 0 },
    provenance: states.map(() => null),
    waitingUntil: null,
    timings: { prices: 0, firstResult: 0, finished: 0, leaveOneOut: 0, longestSlice: 0, loads: [], computes: [] },
  };
}

/** Every scan wording path. */
export function scanScenarios(): Scenario[] {
  const { loo } = base();
  const settings = { stock: "TLT", choice: 90 as WindowChoice, resolution: "hourly" as const, candidates: SCAN_CANDIDATES };
  const cases: [string, ScanSnapshot, Partial<typeof settings>?][] = [
    ["strong", scanSnap({ bh: 0.003, holm: 0.004 })],
    ["strong small link", scanSnap({ bh: 0.003, holm: 0.004, estimate: 0.07, ci: [0.03, 0.11] })],
    ["moderate", scanSnap({ bh: 0.02, holm: 0.03 })],
    ["moderate, daily past 90 days", scanSnap({ bh: 0.001, holm: 0.002 }), { choice: 365, resolution: "daily" as never }],
    ["moderate small link, market lead", scanSnap({ bh: 0.02, holm: 0.06, estimate: 0.05, ci: [0.01, 0.09], leadIndex: 1 })],
    ["fragile (F3)", scanSnap({ bh: 0.02, holm: 0.03, loo: looWith(loo, 3) })],
    ["fragile (F1)", scanSnap({ bh: 0.02, holm: 0.03, effective: 4.2 })],
    ["fragile (check couldn't run)", scanSnap({ bh: 0.02, holm: 0.03, loo: "skipped" })],
    ["no interval", scanSnap({ bh: 0.02, holm: 0.03, ci: null })],
    ["pending leave-one-out", scanSnap({ bh: 0.02, holm: 0.03, loo: "pending", phase: "leave_one_out" })],
    ["still running", scanSnap({ bh: 0.02, holm: 0.03, loo: null, phase: "running", pending: true })],
    ["nothing stood out", scanSnap({ bh: 0.3, holm: 0.6, p: 0.03, estimate: 0.15 })],
    ["not enough data (F1)", scanSnap({ bh: 0.3, holm: 0.6, p: 0.03, effective: 3 })],
    ["with an untested candidate", scanSnap({ bh: 0.02, holm: 0.03, untested: true })],
  ];
  const out = cases.map(([name, snap, over]) => ({ name: `scan ${name}`, summary: scanBottomLine({ ...settings, ...over, snap }) }));
  const none = scanSnap({ bh: 0.02, holm: 0.03 });
  // Fewer candidates tested: the others couldn't be.
  const fewer = (snap: ScanSnapshot, keep: number): ScanSnapshot => ({
    ...snap,
    states: snap.states.map((s, i) => (i < keep ? s : { status: "untested" as const, reason: "Kalshi has no history in this window" })),
    corrections: snap.corrections.map((c, i) => (i < keep ? c : null)),
  });
  out.push({ name: "scan nothing stood out, two tested", summary: scanBottomLine({ ...settings, snap: fewer(scanSnap({ bh: 0.3, holm: 0.6, p: 0.03, estimate: 0.15 }), 2) }) });
  out.push({ name: "scan nothing stood out, one tested", summary: scanBottomLine({ ...settings, snap: fewer(scanSnap({ bh: 0.3, holm: 0.6, p: 0.3, estimate: 0.15 }), 1) }) });
  out.push({ name: "scan nothing tested", summary: scanBottomLine({ ...settings, snap: { ...none, states: none.states.map(() => ({ status: "untested" as const, reason: "x" })), corrections: none.states.map(() => null) } }) });
  out.push({ name: "scan just started", summary: scanBottomLine({ ...settings, snap: { ...none, phase: "running", states: none.states.map(() => ({ status: "loading" as const })), corrections: none.states.map(() => null) } }) });
  // For the gauge, added after the cases above (which stay as they were): leads whose range agrees with their own p.
  const gauge: [string, ScanSnapshot][] = [
    ["nothing stood out, range clear of zero", scanSnap({ bh: 0.3, holm: 0.6, p: 0.03, estimate: 0.15, ci: [0.02, 0.27] })],
    ["nothing stood out, range crossing zero", scanSnap({ bh: 0.6, holm: 0.9, p: 0.2, estimate: -0.08, ci: [-0.2, 0.05] })],
    ["nothing stood out, no range", scanSnap({ bh: 0.6, holm: 0.9, p: 0.2, estimate: 0.11, ci: null })],
    ["strong, past +0.5", scanSnap({ bh: 0.003, holm: 0.004, estimate: 0.56, ci: [0.38, 0.71] })],
  ];
  for (const [name, snap] of gauge) out.push({ name: `scan gauge: ${name}`, summary: scanBottomLine({ ...settings, snap }) });
  return out;
}
