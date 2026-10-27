// Every wording path of the plain-English summary, for the language and wording tests: each rating
// rule for a market and an event at several settings, and a scan's summary in each state. Built from
// real panel results (simulated rows) with the parts each rule reads swapped for hand-made ones.

import type { TestResult } from "@/lib/analytics";
import type { Correction } from "@/lib/analytics/scan";
import type { Fragility, LeaveOneOut } from "@/lib/analytics/fragility";
import type { WindowChoice } from "@/lib/history/window";
import type { ScanCandidate } from "@/lib/scan/types";
import type { CandidateState, ScanSnapshot } from "../scan/scanRunner";
import { plainSummary, scanPlainSummary, type PlainInput, type PlainSummary } from "./summary";
import { detectableAt, EVENT, fragilityWith, looWith, MARKET, plainInput, primaryWith, simulated, withParts } from "./test-helpers";

export interface Scenario {
  name: string;
  summary: PlainSummary;
  input?: PlainInput;
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
export function ruleInput(name: (typeof RULES)[number], over: Partial<PlainInput> = {}): PlainInput {
  const { results, loo } = base();
  const r = rule(name);
  const f = results.fragility!;
  const fragility: Fragility | null = r.fragility === null ? null : r.fragility === undefined ? fragilityWith(f, Math.max(12, f.movement.effective)) : fragilityWith(f, r.fragility);
  const primary = primaryWith(results.market!.primary!, r.primary);
  return plainInput(withParts(results, { primary, fragility }), {
    leaveOneOut: r.loo === undefined ? undefined : r.loo === null ? null : looWith(loo, r.loo),
    detectable: r.detectable === undefined ? (primary.p !== null && primary.p >= 0.05 ? undefined : null) : r.detectable === "missing" ? null : detectableAt(r.detectable),
    ...over,
  });
}

const SETTINGS: { name: string; over: Partial<PlainInput> }[] = [
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
        out.push({ name: `${variable.kind} ${setting.name} ${name}`, summary: plainSummary(input), input });
      }
    }
    for (const unavailable of ["TLT is the benchmark itself", "Loading the benchmark", "Benchmark prices aren’t available"]) {
      const { results } = base();
      const input = plainInput({ ...results, market: { ...results.market!, primary: null, kalshi: null } }, { variable, unavailable, detectable: null, leaveOneOut: null });
      out.push({ name: `${variable.kind} no primary: ${unavailable}`, summary: plainSummary(input), input });
    }
  }
  const raw = simulated({ returns: "raw" });
  const input = plainInput(raw.results, { leaveOneOut: raw.loo, detectable: detectableAt(0.25) });
  out.push({ name: "market raw returns", summary: plainSummary(input), input });
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
  const out = cases.map(([name, snap, over]) => ({ name: `scan ${name}`, summary: scanPlainSummary({ ...settings, ...over, snap }) }));
  const none = scanSnap({ bh: 0.02, holm: 0.03 });
  out.push({ name: "scan nothing tested", summary: scanPlainSummary({ ...settings, snap: { ...none, states: none.states.map(() => ({ status: "untested" as const, reason: "x" })), corrections: none.states.map(() => null) } }) });
  out.push({ name: "scan just started", summary: scanPlainSummary({ ...settings, snap: { ...none, phase: "running", states: none.states.map(() => ({ status: "loading" as const })), corrections: none.states.map(() => null) } }) });
  return out;
}
