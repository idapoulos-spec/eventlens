// The plain-English summary: what an analysis or a scan found, in short sentences and everyday words,
// from exactly what its page already holds. Nothing here computes a statistic: the rating comes from
// lib/analytics/evidence.ts, and every number is the page’s, written by the page’s own formatters
// (accuracy.test.tsx checks them), except the few listed in `derived`, which rescale one the page shows
// or quote the rating’s own rules and simulations. Pure, so the card, the scan, and the reports say the
// same thing. language.test.ts keeps it free of trading language and at about an 8th-grade level.

import { ALPHA, passes, type DetectableCorrelation, type KalshiVariable, type LagCorrelation, type Resolution, type TestResult } from "@/lib/analytics";
import {
  calibrationFor,
  EVIDENCE,
  evidenceRating,
  scanLeadRating,
  type EvidenceLevel,
  type EvidenceRating,
  type FragileChecks,
  type ScanLeadLevel,
  type ScanLeadRating,
} from "@/lib/analytics/evidence";
import { fragileReasons, type Fragility, type LeaveOneOut } from "@/lib/analytics/fragility";
import type { PanelResults } from "@/lib/analytics/panel";
import { formatSigned } from "@/lib/format";
import type { Provenance } from "@/lib/history/types";
import { isLongWindow, type WindowChoice } from "@/lib/history/window";
import { DEFAULT_BENCHMARK } from "@/lib/market-data/benchmark-series";
import type { ScanCandidate } from "@/lib/scan/types";
import { fmtR, plural } from "../research/parts";
import { lowerFirst } from "../research/ResearchPanel";
import { formatCi, formatP } from "../research/stats";
import type { CandidateState, ScanSnapshot } from "../scan/scanRunner";

export type PlainLevel = EvidenceLevel | ScanLeadLevel | "pending" | "none";

export const LEVEL_LABEL: Record<PlainLevel, string> = {
  not_enough_data: "Not enough data",
  no_clear_link: "No clear link",
  nothing_stood_out: "Nothing stood out",
  weak: "Weak",
  moderate: "Moderate",
  strong: "Strong",
  pending: "Checking…",
  none: "No rating",
};

/** Where a level sits on the meter, from No clear link (0) to Strong (3); null when it's off the scale. */
export const METER_STEP: Record<PlainLevel, number | null> = {
  no_clear_link: 0,
  nothing_stood_out: 0,
  weak: 1,
  moderate: 2,
  strong: 3,
  not_enough_data: null,
  pending: null,
  none: null,
};

export interface PlainSection {
  /** "evidence" and "scan-lead" carry the rating (the card's meter, a report's "Evidence:" line). */
  id: "evidence" | "size" | "lead" | "trust" | "limits" | "scan-lead";
  title: string;
  items: string[];
}

export interface PlainSummary {
  headline: string;
  level: PlainLevel;
  sections: PlainSection[];
  /**
   * Numbers in the text that aren't printed elsewhere on the page as written, because they rescale one
   * that is (a size per 10 pp or 25 bp, a lag's count of hours) or quote the rating's own rules and
   * simulations. accuracy.test.tsx checks each against its source.
   */
  derived: string[];
}

/** The one sentence allowed to name buying or selling, and only to say this isn't that (language.test.ts). */
export const NOT_ADVICE = "It is not a prediction, it doesn’t show that one causes the other, and it is not a recommendation to buy or sell anything.";

export const ANALYSIS_LIMITS = `This describes how two series moved together in the past. ${NOT_ADVICE} Other news can move both at once.`;
export const SCAN_LIMITS = `This describes how the stock moved with each candidate in the past. ${NOT_ADVICE} A scan finds leads to check, not findings.`;

export const WINNERS_CURSE_PLAIN =
  "Leads at the top of a scan are probably overstated, because they rank first partly by luck. Expect a smaller link if one is checked again on new data.";

// How often the fragile warning comes on with no real link, by window, from fragility-rates.sim.test.ts
// (the page quotes the same figures in WARNING_BY_CHANCE).
export const WARNING_RATE: Partial<Record<WindowChoice, [string, string]>> = {
  30: ["75.0%", "30-day"],
  90: ["22.5%", "90-day"],
  180: ["13.0%", "180-day"],
  365: ["11.5%", "one-year"],
};

// From evidence-rates.sim.test.ts: hourly, no relationship, 500 data sets per window (README, "Checking
// the rating by simulation"). Strong at 90 days missed its 1.0% bar, so the card says so.
export const RATED_BY_CHANCE = "0.6% of 30-day, 3.2% of 90-day, and 3.6% of 180-day";
export const STRONG_MISS_90 = "1.8% (9 of 500)";
const STRONG_MISS_NUMBERS = ["1.8%", "9", "500", "1%"];

/** How the rating works, under the card and in a report: the rules in words, and how they did in simulation. */
export const RATING_METHOD = [
  "The rating follows fixed rules, set before any results were seen. It looks at the main test’s p-value and at whether the result rests on a few hours or days. When nothing is found, it also looks at how big a link this much data could find.",
  `Strong needs a p-value under ${EVIDENCE.strongP} and a result that doesn’t rest on a few days. A fragile result is never rated above Weak. “No clear link” needs enough data to find a link of ±${EVIDENCE.maxDetectable.toFixed(2)} at least 80% of the time. With less, it’s “Not enough data”.`,
  `In simulations with no real link, hourly data was rated Moderate or Strong in ${RATED_BY_CHANCE} windows. Strong came up in ${STRONG_MISS_90} of 90-day windows, more than the 1% aimed for. Daily data, a year, and All weren’t simulated.`,
];
/** RATING_METHOD's numbers, all quoted from the rules and the simulations. */
export const RATING_METHOD_NUMBERS = ["0.005", "0.30", "80%", "0.6%", "30", "3.2%", "90", "3.6%", "180", ...STRONG_MISS_NUMBERS];

/** |v| as the page shows it, to two decimals. */
const shown = (v: number) => Number(Math.abs(v).toFixed(2));
const upper = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
const sizeWord = (r: number) => (shown(r) < 0.1 ? "slightly" : shown(r) < 0.3 ? "somewhat" : "clearly");

type Words = ReturnType<typeof words>;

/** The words for one resolution: an interval, a block of the bootstrap, and the kind of data. */
function words(resolution: Resolution) {
  return resolution === "hourly"
    ? { unit: ["hour", "hours"] as [string, string], intervals: "trading hours", blocks: ["trading day", "trading days"] as [string, string], data: "hourly" }
    : { unit: ["trading day", "trading days"] as [string, string], intervals: "trading days", blocks: ["run of trading days", "runs of trading days"] as [string, string], data: "daily" };
}

type Mover = ReturnType<typeof mover>;

/** Who moves on the Kalshi side: its name as a subject, and as an owner. */
function mover(kind: KalshiVariable["kind"]) {
  return kind === "probability" ? { name: "Kalshi", owner: "Kalshi’s" } : { name: "the expected rate change", owner: "the expected rate change’s" };
}

/** What rose: "the chance of “Fed maintains rate”", or "the expected rate change". */
const subjectOf = (variable: KalshiVariable) => (variable.kind === "probability" ? `the chance of “${variable.yesLabel}”` : lowerFirst(variable.text.value));

const windowText = (choice: WindowChoice, kind: KalshiVariable["kind"]) =>
  choice === 365 ? "a one-year window" : choice === "all" ? `the ${kind === "probability" ? "market" : "event"}’s whole history` : `a ${choice}-day window`;

export const notPredicting = (unit: string) =>
  `Moving together in the same ${unit} isn’t the same as predicting: both may be reacting to the same news at about the same time.`;

/** "when the chance of … rose, TLT tended to rise slightly in the same hour" */
const tended = (subject: string, stock: string, r: number, unit: string) =>
  `when ${subject} rose, ${stock} tended to ${r > 0 ? "rise" : "fall"} ${sizeWord(r)} in the same ${unit}`;
const beyond = (benchmark: string) => `beyond what moves in ${benchmark} explain`;

/** The fragile warning's tripped checks, one sentence each. */
function fragileSentences(checks: FragileChecks, who: Mover, f: Fragility | null, loo: LeaveOneOut | null | undefined, w: Words): string[] {
  const sentences: string[] = [];
  if (checks.movement) {
    sentences.push(
      f
        ? `${upper(who.owner)} movement was bunched into a few ${w.unit[1]}, worth only about ${f.movement.effective.toFixed(1)} equal ${w.unit[1]} of movement.`
        : "Its diagnostics couldn’t be worked out, so it counts as fragile.",
    );
  }
  if (checks.leaveOneOut) {
    sentences.push(
      loo
        ? `Leaving out one of the ${loo.runs.length} ${w.blocks[1]} that mattered most changed it in ${loo.flips} of ${loo.runs.length} tries.`
        : `The check of leaving out one of the ${w.blocks[1]} at a time couldn’t run, so it counts as fragile.`,
    );
  }
  return sentences;
}

const heldUp = (loo: LeaveOneOut | null | undefined, w: Words) =>
  loo ? `It held up when each of the ${loo.runs.length} ${w.blocks[1]} that mattered most was left out.` : "";

/** Why a p-value is missing, in words. */
function noPText(test: TestResult, w: Words, who: Mover): string {
  switch (test.pUnavailable) {
    case "too_few_blocks":
      return `This window holds only ${plural(test.resampling?.units ?? 0, w.blocks)} with data, too few for the main test (it needs at least 8).`;
    case "too_few_pairs":
      return `Too few ${w.unit[1]} have data on both sides to run the main test.`;
    case "no_variation":
      return `${upper(who.name)} didn’t move in this window, so there’s nothing to test.`;
    case "unstable":
      return `The main test isn’t stable in this window: a single ${w.unit[0]} could decide it.`;
    default:
      return "The main test has no p-value in this window.";
  }
}

/** The main test's numbers, as the page prints them. */
function mainTestLine(test: TestResult): string {
  const ci = test.ci ? ` (95% range ${formatCi(test.ci, fmtR)})` : "";
  return `Main test: correlation r = ${fmtR(test.estimate)}${ci}, ${test.p === null ? "no p-value" : `p-value ${formatP(test.p)}`}.`;
}

export const smallLinkText = (owner: string, stock: string) =>
  `The evidence is convincing, but the link itself is small: ${owner} moves explain only a tiny part of how ${stock} moved.`;

// ---- One analysis ----

/** What the summary reads from the Research panel (or a report's input, which holds the same). */
export interface PlainInput {
  stock: string;
  variable: KalshiVariable;
  choice: WindowChoice;
  resolution: Resolution;
  benchmark: string;
  /** Why market adjustment isn't available, when it isn't. */
  unavailable: string;
  results: PanelResults;
  /** Undefined while the panel is still computing it. */
  detectable: DetectableCorrelation | null | undefined;
  leaveOneOut: LeaveOneOut | null | undefined;
  /** Daily over a window past 90 days. */
  longDaily: boolean;
  windowNote: string | null;
  sources: { provenance: Provenance | null };
  windowEnd: number | null;
  windowFrozen: boolean;
  frozenAt: number | null;
}

export function plainSummary(i: PlainInput): PlainSummary {
  const w = words(i.resolution);
  const who = mover(i.variable.kind);
  const primary = i.results.market?.primary ?? null;
  const rating = evidenceRating({
    primary,
    fragility: i.results.fragility,
    leaveOneOut: i.leaveOneOut,
    detectable: i.detectable,
    calibration: calibrationFor(i.resolution, i.choice, i.longDaily),
  });
  const derived: string[] = [];
  return {
    headline: headline(i, rating, primary, w),
    level: rating.level,
    sections: [
      { id: "evidence", title: "How strong is the evidence?", items: evidenceItems(i, rating, primary, w, who, derived) },
      { id: "size", title: "How big is it?", items: sizeItems(i, primary, w, derived) },
      { id: "lead", title: `Does ${who.name} move first?`, items: [leadText(i.results.view.lags, i.results.shown, i.stock, w, who, derived)] },
      { id: "trust", title: "How much to trust it", items: trustItems(i, rating, primary, w, who, derived) },
      { id: "limits", title: "What this can’t tell you", items: [ANALYSIS_LIMITS] },
    ],
    derived,
  };
}

function headline(i: PlainInput, rating: EvidenceRating, primary: TestResult | null, w: Words): string {
  const subject = subjectOf(i.variable);
  const r = primary?.estimate ?? 0;
  const unit = w.unit[0];
  switch (rating.level) {
    case "none":
      return `No main test in this view: ${lowerFirst(i.unavailable)}.`;
    case "pending":
      return `Working out what this window shows about ${i.stock} and ${subject}…`;
    case "not_enough_data":
      return `Not enough data to tell whether ${i.stock} moved with ${subject} in the same ${unit}, ${beyond(i.benchmark)}.`;
    case "no_clear_link":
      return `No clear link between ${subject} and ${i.stock} in the same ${unit}, ${beyond(i.benchmark)}.`;
    case "weak":
      return `A weak sign: ${tended(subject, i.stock, r, unit)}, ${beyond(i.benchmark)}.`;
    case "moderate":
    case "strong":
      return `${upper(tended(subject, i.stock, r, unit))}, ${beyond(i.benchmark)}.`;
  }
}

function evidenceItems(i: PlainInput, rating: EvidenceRating, primary: TestResult | null, w: Words, who: Mover, derived: string[]): string[] {
  if (primary === null) return [`No rating: the main test can’t run here (${lowerFirst(i.unavailable)}).`];
  const p = primary.p === null ? "—" : formatP(primary.p);
  const noLink = `The main test found no clear link (p-value ${p}).`;
  const d = i.detectable;
  const text: string[] = [];
  switch (rating.rule) {
    case "no_primary":
      break;
    case "no_p":
      text.push(noPText(primary, w, who));
      break;
    case "pending":
      text.push(primary.p !== null && primary.p < ALPHA ? `Checking how much the result rests on a few ${w.blocks[1]}…` : "Working out how big a link this much data could find…");
      break;
    case "few_moves":
      text.push(
        noLink,
        i.results.fragility
          ? `But ${who.owner} movement was bunched into a few ${w.unit[1]}, worth only about ${i.results.fragility.movement.effective.toFixed(1)} equal ${w.unit[1]} of movement.`
          : "But its diagnostics couldn’t be worked out.",
        "So a real link could easily be missed.",
      );
      break;
    case "low_power":
      derived.push(EVIDENCE.maxDetectable.toFixed(2));
      text.push(
        noLink,
        !d
          ? "But how big a link this much data could find couldn’t be worked out, so a missed link can’t be ruled out."
          : `But with this much data, only a link ${d.r === null ? `stronger than about ±${d.max.toFixed(1)}` : `of about ±${d.r.toFixed(2)} or stronger`} would be found ${Math.round(d.power * 100)}% of the time.`,
      );
      if (d) text.push("So a real but weaker link could easily be missed.", `“No clear link” needs ±${EVIDENCE.maxDetectable.toFixed(2)} or better.`);
      break;
    case "power_miss":
      text.push(
        noLink,
        `In tests, the measure of how big a link this much data can find was too hopeful for ${i.choice === 30 ? "30-day" : "180-day daily"} windows.`,
        "So a missed link can’t be ruled out.",
      );
      break;
    case "no_link":
      text.push(
        noLink,
        `With this much data, a link of about ±${d!.r!.toFixed(2)} or stronger would have been found ${Math.round(d!.power * 100)}% of the time.`,
        "So a strong link is unlikely, but a weaker one can’t be ruled out.",
      );
      break;
    case "fragile":
      text.push(
        `The main test’s p-value is ${p}, under 0.05. But the result is fragile.`,
        ...fragileSentences(rating.fragile, who, i.results.fragility, i.leaveOneOut, w),
        "Fragile results are never rated above Weak.",
      );
      break;
    case "no_interval":
      text.push(`The main test’s p-value is ${p}, under 0.05. But it couldn’t give a range for the link, so it’s rated Weak.`);
      break;
    case "strong":
      derived.push(String(EVIDENCE.strongP));
      text.push(`The main test’s p-value is ${p}, under ${EVIDENCE.strongP}.`, heldUp(i.leaveOneOut, w));
      break;
    case "moderate":
      derived.push(String(EVIDENCE.strongP));
      text.push(
        `The main test’s p-value is ${p}, under 0.05.`,
        heldUp(i.leaveOneOut, w),
        primary.p! < EVIDENCE.strongP
          ? "It isn’t rated Strong because, in tests, daily data over long windows gave ranges that were a bit too narrow."
          : `Strong needs a p-value under ${EVIDENCE.strongP}.`,
      );
      break;
  }
  const items = [text.filter(Boolean).join(" ")];
  if (rating.smallLink) items.push(smallLinkText(who.owner, i.stock));
  items.push(mainTestLine(primary));
  return items;
}

/** The regression's Kalshi coefficient for a 10 pp rise (a market) or a 25 bp one (an event in bp). */
function sizeItems(i: PlainInput, primary: TestResult | null, w: Words, derived: string[]): string[] {
  const fit = i.results.market?.kalshi ?? null;
  if (!fit) return [i.results.market ? "There’s too little data to put a size on it." : "There’s no size to give without a benchmark."];
  const { variable, stock, benchmark } = i;
  const scale = variable.kind === "probability" ? 10 : variable.unit === "bp" ? 25 : 1;
  const step =
    variable.kind === "probability"
      ? `Take a 10-percentage-point rise in ${subjectOf(variable)}, say from 40% to 50%.`
      : variable.unit === "bp"
        ? `Take a 25-basis-point rise in ${subjectOf(variable)}, the size of one usual Fed move.`
        : `Take a rise of 1 ${variable.unit} in ${subjectOf(variable)}.`;
  const fmt = (v: number) => formatSigned(v * scale, 2, "%");
  const ci = fit.test.ci;
  derived.push(fmt(fit.coef), String(scale));
  if (variable.kind === "probability") derived.push("40%", "50%");
  if (ci) derived.push(fmt(ci[0]), fmt(ci[1]));
  const text = [step, `With ${benchmark}’s move held fixed, that went with about a ${fmt(fit.coef)} move in ${stock} in the same ${w.unit[0]}.`];
  if (!ci) text.push("The test couldn’t give a range for it.");
  else {
    text.push(`The likely range is ${fmt(ci[0])} to ${fmt(ci[1])}.`);
    if (ci[0] <= 0 && ci[1] >= 0) text.push("The range includes zero, so the true effect could be none at all.");
  }
  const r = primary?.estimate ?? null;
  if (r !== null && r !== 0 && fit.coef !== 0 && Math.sign(fit.coef) !== Math.sign(r)) text.push("This size points the other way from the main test, so its direction is unclear.");
  return [text.join(" "), "It comes from the “Kalshi, with the market held fixed” check under Market adjustment."];
}

function leadText(lags: LagCorrelation[], shown: PanelResults["shown"], stock: string, w: Words, who: Mover, derived: string[]): string {
  const tested = lags.filter((l) => l.test.role === "exploratory" && l.test.p !== null);
  if (tested.length === 0) return `There isn’t enough data to check which moved first. ${notPredicting(w.unit[0])}`;
  const passing = tested.filter((l) => l.lag !== 0 && passes(l.test, "bh")).sort((a, b) => a.test.p! - b.test.p!);
  const checked = `${tested.length} time ${tested.length === 1 ? "shift" : "shifts"}`;
  const span = (lag: number) => {
    derived.push(String(Math.abs(lag)));
    return plural(Math.abs(lag), w.unit);
  };
  const kalshiFirst = passing.find((l) => l.lag > 0);
  const stockFirst = passing.find((l) => l.lag < 0);
  const parts: string[] = [];
  if (kalshiFirst) {
    parts.push(`Maybe: ${stock} tended to move ${span(kalshiFirst.lag)} after ${who.name} did, even after correcting for checking ${checked}.`, "That’s a lead to check, not a finding.");
  }
  if (stockFirst) {
    parts.push(`${kalshiFirst ? "Also" : "If anything"}, ${stock} moved first: ${who.name} tended to move ${span(stockFirst.lag)} after ${stock} did, even after correcting for checking ${checked}.`);
  }
  if (parts.length === 0) parts.push(`No clear sign: after correcting for checking ${checked}, neither tended to move first.`);
  parts.push(notPredicting(w.unit[0]));
  if (shown === "raw") parts.push("This uses raw returns, as picked above, so market-wide moves are still in them.");
  return parts.join(" ");
}

function trustItems(i: PlainInput, rating: EvidenceRating, primary: TestResult | null, w: Words, who: Mover, derived: string[]): string[] {
  const items: string[] = [];
  const { results, choice, resolution } = i;
  const stats = results.view.sameInterval;
  const f = results.fragility;
  const loo = i.leaveOneOut;

  if (primary?.p != null && f) {
    if (loo === undefined) {
      items.push(`Still checking how much the result rests on a few ${w.blocks[1]}…`);
    } else {
      const reasons = fragileReasons(f, loo);
      if (reasons.length > 0) {
        const checks = { movement: reasons.includes("movement"), leaveOneOut: reasons.includes("leave_one_out") };
        const rate = resolution === "hourly" ? WARNING_RATE[choice] : undefined;
        items.push(
          [
            "This result is fragile.",
            ...fragileSentences(checks, who, f, loo, w),
            rate ? `Even with no real link, this warning comes on by chance in ${rate[0]} of ${rate[1]} windows in tests.` : "",
          ]
            .filter(Boolean)
            .join(" "),
        );
      } else if (loo) {
        items.push(`Stable: leaving out any one of the ${loo.runs.length} ${w.blocks[1]} that mattered most didn’t change the result.`);
      }
    }
    const units = primary.resampling?.units ?? null;
    items.push(
      `Based on ${f.movement.intervals.toLocaleString("en-US")} ${w.intervals} in ${windowText(choice, i.variable.kind)}; ${who.name} moved in ${f.movement.moves.toLocaleString("en-US")} of them${
        units === null ? "" : `, across ${plural(units, w.blocks)}`
      }.`,
    );
  } else {
    items.push(`Based on ${results.view.changes.length.toLocaleString("en-US")} ${w.intervals} in ${windowText(choice, i.variable.kind)}; ${who.name} moved in ${stats.kalshiMoves.toLocaleString("en-US")} of them.`);
  }
  if (choice === 7 || choice === 30) items.push(`Short window: only ${choice} days of ${w.data} data, so results can swing a lot.`);
  if (stats.n > 0 && stats.fewKalshiMoves) items.push(`${upper(who.name)} moved in only ${plural(stats.kalshiMoves, w.unit)}, so a few moves decide the result.`);
  if (i.windowNote) items.push(i.windowNote);

  const overlap = results.market?.kalshiVsBenchmark;
  if (overlap && overlap.test.p !== null && overlap.test.p < ALPHA) {
    items.push(`${upper(who.owner)} moves also went with ${i.benchmark}’s (r = ${fmtR(overlap.r)}), so adjusting for the market may take out part of the link.`);
  }
  if (i.longDaily && primary?.p != null) items.push("In tests, daily data over long windows gave ranges that were a bit too narrow. They held the true value 90% of the time, not 95%.");
  if (rating.level === "strong" && resolution === "hourly" && choice === 90) {
    derived.push(...STRONG_MISS_NUMBERS);
    items.push(`In simulations with no real link, 90-day hourly windows were rated Strong ${STRONG_MISS_90} of the time, more than the 1% aimed for.`);
  }
  if (primary?.p != null && (resolution === "daily" || choice === 365 || choice === "all")) {
    items.push("The evidence rating was checked in simulations of hourly 30, 90, and 180-day windows only; this setting wasn’t simulated.");
  }

  const prov = i.sources.provenance;
  items.push(
    !prov || prov.storedThrough === null
      ? "Kalshi’s history here comes straight from Kalshi."
      : prov.liveFailed
        ? "Kalshi’s history here comes from EventLens’s stored copy; later prices couldn’t be loaded."
        : prov.liveFrom === null
          ? "Kalshi’s history here comes from EventLens’s stored copy."
          : "Kalshi’s history here comes from EventLens’s stored copy, with live data after that.",
  );
  items.push(
    i.frozenAt !== null || i.windowFrozen
      ? "Frozen: this view’s link gives these same numbers later."
      : i.windowEnd !== null
        ? `The window ends at the ${i.variable.kind === "probability" ? "market" : "event"}’s close, so these numbers won’t change as time passes.`
        : "The window ends now, so these numbers will change as new data comes in. Freeze the view to keep them.",
  );
  return items;
}

// ---- A scan ----

export interface ScanPlainInput {
  stock: string;
  choice: WindowChoice;
  resolution: Resolution;
  candidates: ScanCandidate[];
  snap: ScanSnapshot;
}

type Done = Extract<CandidateState, { status: "done" }>;

/** The scan's leave-one-out state for the rating: undefined while it's still to run or running, null when it couldn't. */
function scanLoo(state: Done, phase: ScanSnapshot["phase"]): LeaveOneOut | null | undefined {
  if (state.loo === "skipped") return null;
  if (state.loo === "pending" || (state.loo === null && phase !== "done")) return undefined;
  return state.loo;
}

/** The candidates' noun: events, markets, or both. */
function candidateNoun(candidates: ScanCandidate[]): [string, string] {
  const kinds = new Set(candidates.map((c) => c.kind));
  if (kinds.size === 1) return kinds.has("event") ? ["event", "events"] : ["market", "markets"];
  return ["market or event", "markets and events"];
}

export function scanPlainSummary({ stock, choice, resolution, candidates, snap }: ScanPlainInput): PlainSummary {
  const w = words(resolution);
  const derived: string[] = [];
  const tested = snap.states.flatMap((s, i) => (s.status === "done" ? [{ s, i }] : []));
  const untested = snap.states.filter((s) => s.status === "untested").length;
  const final = tested.length + untested === snap.states.length;
  const limits: PlainSection = { id: "limits", title: "What this can’t tell you", items: [SCAN_LIMITS] };

  if (tested.length === 0) {
    return { headline: final ? "None of the candidates could be tested." : "Results appear here as each candidate finishes.", level: final ? "none" : "pending", sections: [limits], derived };
  }

  const noun = candidateNoun(tested.map(({ i }) => candidates[i]));
  const under = tested.filter(({ s }) => (s.test.primary?.p ?? 1) < ALPHA).length;
  const holm = snap.corrections.filter((c) => c?.survivesHolm).length;
  const bh = snap.corrections.filter((c) => c?.survivesBh).length;
  const expected = (ALPHA * tested.length).toLocaleString("en-US", { maximumFractionDigits: 1 });
  const first = `${final ? "Out" : "So far, out"} of ${plural(tested.length, noun)} tested, ${bh === 0 ? "none" : bh} still looked related after correcting for testing many at once.${
    bh === 0 ? "" : holm === 0 ? " None passed the stricter check." : ` ${holm} also passed the stricter check.`
  }`;
  const second = `Before correcting, ${under} had p-values under 0.05, where about ${expected} would be expected by chance alone even if none were related.`;

  const index = snap.order.find((i) => snap.states[i].status === "done")!;
  const state = snap.states[index] as Done;
  const rating = scanLeadRating({
    primary: state.test.primary!,
    fragility: state.test.fragility,
    leaveOneOut: scanLoo(state, snap.phase),
    bh: snap.corrections[index]?.bh ?? 1,
    calibration: calibrationFor(resolution, choice, isLongWindow(choice) && !state.sameAs90),
  });
  return {
    headline: `${first} ${second}`,
    level: rating.level,
    sections: [
      {
        id: "scan-lead",
        title: final ? "The strongest lead" : "The strongest lead so far",
        items: scanLeadItems(stock, candidates[index], state, rating, snap.corrections[index]?.bh ?? 1, w, tested.length, final, derived),
      },
      limits,
    ],
    derived,
  };
}

function scanLeadItems(stock: string, c: ScanCandidate, state: Done, rating: ScanLeadRating, bh: number, w: Words, tested: number, final: boolean, derived: string[]): string[] {
  const primary = state.test.primary!;
  const who = mover(c.kind === "event" ? "expected" : "probability");
  const subject = c.kind === "event" ? "the expected rate change" : `the chance of “${c.label ?? c.title}”`;
  const name = `“${c.title}” (${c.ticker})`;
  const numbers = `r = ${fmtR(primary.estimate)}${primary.ci ? ` (95% range ${formatCi(primary.ci, fmtR)})` : ""}`;
  const loo = state.loo !== null && typeof state.loo === "object" ? state.loo : null;
  const text: string[] = [];
  switch (rating.rule) {
    case "not_surviving":
    case "few_moves":
      text.push(`Closest to standing out: ${name}, with ${numbers}.`, "It didn’t survive the correction for testing many at once.");
      if (rating.rule === "few_moves") {
        text.push(`Also, ${who.owner} movement was bunched into a few ${w.unit[1]}, so a real link could easily be missed.`);
      } else {
        derived.push(String(tested - 1));
        text.push(
          "A scan doesn’t check how big a link each one’s data could find; its own page does.",
          `On its own page it may look stronger, because that page doesn’t correct for the other ${tested - 1} tests.`,
        );
      }
      break;
    default:
      text.push(`The strongest lead is ${name}.`, `${upper(tended(subject, stock, primary.estimate ?? 0, w.unit[0]))}, ${beyond(DEFAULT_BENCHMARK.symbol)}.`, `Its correlation: ${numbers}.`);
      switch (rating.rule) {
        case "pending":
          text.push(final ? `Still checking how much it rests on a few ${w.blocks[1]}…` : "Its rating waits for every candidate, then for a check of how much the top results rest on a few days.");
          break;
        case "fragile":
          text.push("It survives the correction, but it’s fragile.", ...fragileSentences(rating.fragile, who, state.test.fragility, loo, w));
          break;
        case "no_interval":
          text.push("It survives the correction, but its test couldn’t give a range for the link.");
          break;
        case "strong":
          derived.push(String(EVIDENCE.strongP));
          text.push(`It survives the correction with a corrected p-value under ${EVIDENCE.strongP}.`, heldUp(loo, w));
          break;
        case "moderate":
          derived.push(String(EVIDENCE.strongP));
          text.push(
            "It survives the correction.",
            heldUp(loo, w),
            bh < EVIDENCE.strongP
              ? "It isn’t rated Strong because, in tests, daily data over long windows gave ranges that were a bit too narrow."
              : `Strong needs a corrected p-value under ${EVIDENCE.strongP}.`,
          );
          break;
      }
  }
  const items = [text.filter(Boolean).join(" ")];
  if (rating.smallLink) items.push(smallLinkText(who.owner, stock));
  items.push(WINNERS_CURSE_PLAIN, "Open its full analysis for the details.");
  return items;
}
