// One analysis's report, from exactly what its Research panel holds when exported: its settings,
// its results, the detectable size and leave-one-out check, and where the data came from. The
// numbers are the page's, written by the page's own formatters (accuracy.test.tsx compares them).
//
// Left out, so the report carries no stock data finer than a statistic (Twelve Data's free plan
// doesn't allow showing its data outside the app): stock prices of any kind, each influential
// hour's abnormal return, and the event study's averages for rises or falls with fewer than
// MIN_TEST_EVENTS events, which are close to one event's return path.

import { ALPHA, MIN_TEST_EVENTS, passes, type DetectableCorrelation, type EventStudy, type EventStudyTests, type KalshiVariable, type LagCorrelation, type Resolution, type TestResult } from "@/lib/analytics";
import { correlationStats } from "@/lib/analytics/correlation";
import { DESCRIPTIVE_MIN_SESSIONS, FRAGILE, fragileReasons, type Fragility, type LeaveOneOut } from "@/lib/analytics/fragility";
import type { PanelResults, Returns } from "@/lib/analytics/panel";
import { formatShortDate, formatSigned } from "@/lib/format";
import type { Provenance } from "@/lib/history/types";
import { provenanceNote, WINDOW_LABEL, type WindowChoice } from "@/lib/history/window";
import type { Block, Report, Section } from "@/lib/report/model";
import { eventStudyChart, leadLagChart, rollingChart } from "@/lib/report/charts";
import { reportInstant, reportTime } from "@/lib/report/format";
import { MAY_DIFFER, REPRODUCED } from "../analysis/reproducibility";
import { formatLag } from "../charts/LeadLagChart";
import { DISCLAIMER } from "../Disclaimer";
import { formatAlpha, intervalNoun, modelSample, NEAR_DUPLICATE_R2, NEWEY_WEST_NOTE, verdictText, type ModelSample } from "../research/MarketAdjustmentCard";
import { fmtR, plural } from "../research/parts";
import {
  adjustmentNote,
  betaFrom,
  EXCLUSION_LABEL,
  eventFlag,
  F2_BY_CHANCE,
  intervalText,
  LONG_DAILY_COVERAGE,
  LONG_DAILY_FALSE_POSITIVES,
  lowerFirst,
  REASON_TEXT,
  ROLLING_EXTRA,
  sampleFlags,
  sessionText,
  SETTINGS,
  UNRELIABLE_DAILY,
  WARNING_BY_CHANCE,
  when,
  type Adjustment,
} from "../research/ResearchPanel";
import { eventFamilyText, formatCi, formatN, formatP, methodText, TEST_COLUMNS, testCells, unavailableText } from "../research/stats";

/** Where the analysis's data came from, as the page loaded it. */
export interface ReportSources {
  /** When the Kalshi market (or event) was fetched. */
  kalshiFetchedAt: number | null;
  /** When the stock's bars were fetched. */
  stockFetchedAt: number | null;
  /** Research's 90-day Kalshi history: stored candles, a live tail, or live. */
  provenance: Provenance | null;
  /** The market's title, or the event's. */
  title: string | null;
}

export interface AnalysisReportInput {
  stock: string;
  kalshi: string;
  variable: KalshiVariable;
  choice: WindowChoice;
  resolution: Resolution;
  threshold: number;
  /** The returns picked, and the ones shown (raw when adjustment isn't possible). */
  chosenReturns: Returns;
  benchmark: string;
  /** When the benchmark's bars were fetched, if it has any. */
  benchmarkFetchedAt: number | null;
  isSelf: boolean;
  /** Why market adjustment isn't available, when it isn't. */
  unavailable: string;
  /** Windows end here (ms). */
  asOf: number;
  /** A closed market's close or a frozen link's as-of time, when the windows end there rather than now. */
  windowEnd: number | null;
  windowFrozen: boolean;
  /** The link's as-of time, if the view is frozen. */
  frozenAt: number | null;
  /** The panel's note on a window cut short by the market's life, if any. */
  windowNote: string | null;
  results: PanelResults;
  detectable: DetectableCorrelation | null;
  leaveOneOut: LeaveOneOut | null;
  sample: ModelSample;
  /** 30-day daily: the detectable size was validated as unreliable. */
  fewRuns: boolean;
  /** Daily over a window past 90 days: intervals run a little narrow. */
  longDaily: boolean;
  sources: ReportSources;
  /** The reproducible link (absolute), or null when left out. */
  link: string | null;
  preparedBy: string | null;
  generatedAt: number;
  version: string;
  commit: string;
}

/** Text ending as a sentence: a period added unless it already ends in one, or in "?" or "!" (Kalshi's titles are often questions). */
export const asSentence = (text: string) => (/[.?!]["”’)]?$/.test(text.trim()) ? text.trim() : `${text.trim()}.`);

const pct = (share: number) => `${Math.round(share * 100)}%`;
const enough = (n: number) => n >= MIN_TEST_EVENTS;
const p = (text: string): Block => ({ kind: "paragraph", text });

/** The primary result in one line, as the page's ResultLine and verdict say it. */
export function resultLine(test: TestResult, label = "r"): string {
  const estimate = test.estimate === null ? "—" : fmtR(test.estimate);
  const ci = test.ci ? ` (95% CI ${formatCi(test.ci, fmtR)})` : "";
  const pv = test.p !== null ? `, p = ${formatP(test.p)}` : "";
  const verdict = test.p === null ? "" : `: ${passes(test, "raw") ? "distinguishable" : "not distinguishable"} from zero at the ${ALPHA * 100}% level`;
  return `${label} = ${estimate}${ci}${pv}, n = ${formatN(test)}${verdict}.`;
}

/** The page's DetectableLine in words. */
export function detectableText(d: DetectableCorrelation, fewRuns: boolean): string {
  const units = plural(d.units, d.unit === "day_run" ? ["run of days", "runs of days"] : ["session", "sessions"]);
  const power = `${Math.round(d.power * 100)}%`;
  const lead =
    d.r === null
      ? `With these ${units}, only a correlation stronger than about ±${d.max.toFixed(1)} would be detected ${power} of the time, so this result says little either way.`
      : `With these ${units}, a correlation of about ±${d.r.toFixed(2)} or larger would be detected ${power} of the time, so this result says little about smaller ones.`;
  const how = ` A rough guide, simulated from this sample: ${d.samples.toLocaleString("en-US")} versions with Kalshi’s changes and the stock’s volatility as observed and an effect built in, allowing for how uncertain that volatility is.`;
  const unreliable =
    fewRuns && d.r !== null
      ? ` Unreliable with this few runs of days: in simulations with 20 daily intervals, effects of the size shown were detected only ${UNRELIABLE_DAILY} of the time, not 80%.`
      : "";
  return `${lead}${how}${unreliable}`;
}

function question(i: AnalysisReportInput): Section {
  const settings = SETTINGS[i.resolution];
  const what =
    i.variable.kind === "probability"
      ? `Kalshi’s probability that ${i.kalshi} resolves YES (“${i.variable.yesLabel}”)`
      : `${lowerFirst(i.variable.text.value)} for Kalshi event ${i.kalshi}`;
  const changes = i.results.view.changes;
  const span = changes.length > 0 ? ` (${formatShortDate(changes[0].t)} – ${formatShortDate(changes[changes.length - 1].t)})` : "";
  return {
    id: "question",
    title: "Question",
    blocks: [
      p(
        `Did changes in ${what} move with ${i.stock}’s market-adjusted returns (net of ${i.benchmark}) in the same ${settings.noun[0]}, over the ${WINDOW_LABEL[i.choice]} window ending ${reportTime(i.asOf)}${span}?`,
      ),
      p("That is the primary test, chosen before looking at the data and judged on its own p-value. Everything else in this report is exploratory: leads to check, not findings."),
      ...(i.sources.title ? [p(`Kalshi: ${asSentence(i.sources.title)}`)] : []),
    ],
  };
}

function inputs(i: AnalysisReportInput): Section {
  const settings = SETTINGS[i.resolution];
  const shown = i.results.shown;
  const returns =
    shown === "adjusted"
      ? `Market-adjusted (vs. ${i.benchmark})`
      : i.chosenReturns === "adjusted"
        ? `Raw: ${lowerFirst(i.unavailable)}, so market-adjusted returns can’t be computed`
        : "Raw";
  const ends =
    i.frozenAt !== null
      ? `Frozen as of ${reportInstant(i.frozenAt)}${i.windowEnd !== null && !i.windowFrozen && i.windowEnd !== i.frozenAt ? `; the ${i.variable.kind === "probability" ? "market" : "event"} had closed by then, so the windows end at its close, ${reportTime(i.windowEnd)}` : ""}`
      : i.windowEnd !== null
        ? `At the ${i.variable.kind === "probability" ? "market’s" : "event’s first"} close, ${reportInstant(i.windowEnd)}`
        : `Now, when the page loaded: ${reportInstant(i.asOf)} (not frozen)`;
  return {
    id: "inputs",
    title: "Inputs",
    blocks: [
      {
        kind: "facts",
        rows: [
          ["Stock", i.stock],
          [i.variable.kind === "probability" ? "Kalshi market" : "Kalshi event", i.variable.kind === "probability" ? `${i.kalshi} (YES = “${i.variable.yesLabel}”)` : `${i.kalshi} (${lowerFirst(i.variable.text.value)}, in ${i.variable.unit})`],
          ["Window", WINDOW_LABEL[i.choice]],
          ["Windows end", ends],
          ["Resolution", i.resolution === "hourly" ? "Hourly (trading hours, 10 AM–4 PM New York)" : "Daily (close to close)"],
          ["Returns shown", returns],
          ["Benchmark", i.isSelf ? `${i.benchmark} (the stock itself, so no market adjustment)` : i.benchmark],
          ["Jump size (event study)", `≥ ${i.threshold} ${i.variable.unit} in one ${settings.noun[0]}`],
        ],
      },
      ...(i.windowNote ? [p(i.windowNote)] : []),
    ],
  };
}

function sources(i: AnalysisReportInput): Section {
  const stored = i.sources.provenance ? provenanceNote(i.sources.provenance) : null;
  return {
    id: "sources",
    title: "Data sources",
    blocks: [
      {
        kind: "facts",
        rows: [
          ["Kalshi", `Public market data${i.sources.kalshiFetchedAt !== null ? `, fetched ${reportTime(i.sources.kalshiFetchedAt)}` : ""}. ${stored ?? "Research history read from Kalshi’s API."}`],
          [
            "Twelve Data",
            `${i.stock}’s bars fetched ${i.sources.stockFetchedAt !== null ? reportTime(i.sources.stockFetchedAt) : "—"}${i.benchmarkFetchedAt !== null && !i.isSelf ? `; ${i.benchmark}’s ${reportTime(i.benchmarkFetchedAt)}` : ""}.`,
          ],
        ],
      },
      p("Stock and benchmark prices are left out of this report under Twelve Data’s terms; only statistics computed from them are shown. All times are New York time."),
    ],
  };
}

function methods(i: AnalysisReportInput): Section {
  const settings = SETTINGS[i.resolution];
  const primary = i.results.market?.primary ?? null;
  const model = i.results.market?.model ?? null;
  const changes = i.variable.kind === "probability" ? "Kalshi changes" : "changes in E (ΔE)";
  const items = [
    `Primary test: the same-${settings.noun[0]} correlation of ${changes} with ${i.stock}’s market-adjusted returns, compared only where both have a real observation. It was chosen before looking at the data, so it’s judged on its own p-value.`,
    primary && primary.p !== null ? `Significance: ${methodText(primary)}` : "Significance: a wild bootstrap by session (hourly) or run of trading days (daily), with alpha and beta refitted in every draw.",
    model
      ? `Market adjustment: ${i.stock}’s return minus (alpha + beta × ${i.benchmark}’s return), all log returns over the same interval, with alpha and beta from ${modelSample(model, i.resolution, i.sample)}.`
      : `Market adjustment: not possible here (${lowerFirst(i.unavailable)}).`,
    "Corrections: the lead-lag chart’s exploratory lags are corrected as one family, the event study’s bars as another, and its whole-path tests as a third, each with Holm (the chance of any false positive held at 5%) and Benjamini–Hochberg (the expected share of false positives among those that pass held at 5%). Switching window, resolution, or benchmark until something looks significant isn’t corrected for.",
    "Power: when the primary test isn’t significant, the smallest correlation it would detect 80% of the time is simulated from this sample.",
    `Fragility: how much the primary result rests on a few ${settings.noun[1]} or sessions, with a warning at thresholds fixed before any result was seen.`,
    "Rolling correlation is descriptive only; no significance is claimed for it.",
  ];
  return { id: "methods", title: "Methods", blocks: [{ kind: "list", items }] };
}

function summary(i: AnalysisReportInput, adjustment: Adjustment | null): Block[] {
  const { results, resolution, variable } = i;
  const settings = SETTINGS[resolution];
  const changes = results.view.changes;
  const stats = results.view.sameInterval;
  const noun = intervalNoun(resolution);
  const range = changes.length > 0 ? ` (${formatShortDate(changes[0].t)} – ${formatShortDate(changes[changes.length - 1].t)})` : "";
  const r =
    stats.r !== null
      ? ` ${settings.same} correlation${adjustment ? `, market-adjusted vs. ${adjustment.benchmark}` : ""}: ${fmtR(stats.r)}${adjustment ? ` (raw ${fmtR(results.rawSame.r)})` : ""}.`
      : "";
  const blocks: Block[] = [p(`${plural(changes.length, noun)}${range}, ${variable.text.subject} moved in ${plural(stats.kalshiMoves, settings.noun)}.${r}`)];
  if (adjustment) blocks.push(p(`Market-adjusted returns use ${betaFrom(adjustment.model, resolution, adjustment.sample)}.`));
  const left = Object.entries(results.series.excluded)
    .filter(([, n]) => n > 0)
    .map(([reason, n]) => `${n.toLocaleString("en-US")} ${EXCLUSION_LABEL[resolution][reason] ?? reason}`);
  if (adjustment && adjustment.missingBenchmark > 0) left.push(`${adjustment.missingBenchmark.toLocaleString("en-US")} without a ${adjustment.benchmark} price at both ends`);
  if (left.length > 0) blocks.push(p(`Left out: ${left.join(" · ")}.`));
  const flags = sampleFlags(stats, variable);
  if (flags.length > 0) blocks.push({ kind: "callout", title: "Sample", items: flags });
  return blocks;
}

function primaryBlocks(i: AnalysisReportInput): Block[] {
  const primary = i.results.market?.primary ?? null;
  if (primary === null) {
    return [p(`No primary test: ${lowerFirst(i.unavailable)}, so there are no market-adjusted returns to test. Every result below is exploratory.`)];
  }
  const blocks: Block[] = [p(resultLine(primary))];
  const significant = primary.p != null && primary.p < ALPHA;
  if (i.detectable) blocks.push(p(detectableText(i.detectable, i.fewRuns)));
  else if (!significant && primary.p !== null) blocks.push(p("The detectable size couldn’t be worked out for this sample."));
  const missing = unavailableText(primary);
  if (missing) blocks.push(p(missing));
  if (i.longDaily && primary.p !== null) {
    blocks.push(
      p(
        `Daily data over a long window runs a little liberal: in simulations with a year of trading days, these 95% intervals covered the true value only ${LONG_DAILY_COVERAGE} of the time, and with no link ${LONG_DAILY_FALSE_POSITIVES} came out below 0.05. Read the interval as somewhat too narrow.`,
      ),
    );
  }
  return blocks;
}

function fragilityBlocks(i: AnalysisReportInput, f: Fragility, loo: LeaveOneOut | null, primary: TestResult): Block[] {
  const { resolution, variable } = i;
  const reasons = fragileReasons(f, loo);
  const blocks_: [string, string] = f.unit === "day_run" ? ["run of days", "runs of days"] : ["session", "sessions"];
  const intervals: [string, string] = resolution === "hourly" ? ["hour", "hours"] : ["day", "days"];
  const mover = variable.kind === "probability" ? "Kalshi’s probability" : "E";
  const decision = (t: TestResult) => (t.p === null ? "no p-value" : t.p < ALPHA ? "p < 0.05" : "p ≥ 0.05");
  const runText = (t: TestResult) => (t.p === null ? "no p-value (too few left)" : `r = ${fmtR(t.estimate)}, p = ${formatP(t.p)}`);
  const out: Block[] = [];
  if (reasons.length > 0) out.push({ kind: "callout", title: "Fragile", items: reasons.map((r) => REASON_TEXT[r]) });
  else if (loo) out.push(p("No fragility warning."));
  const looText = loo
    ? `Leaving out each of the ${loo.runs.length} most influential ${blocks_[1]} in turn: r from ${fmtR(loo.estimate?.[0] ?? null)} to ${fmtR(loo.estimate?.[1] ?? null)}${
        loo.p ? `, p from ${formatP(loo.p[0])} to ${formatP(loo.p[1])}` : ""
      }; ${loo.flips === 0 ? "the decision at 5% never changes" : `the decision at 5% changes in ${loo.flips} of ${loo.runs.length}`}${
        loo.unavailable > 0 ? ` (${loo.unavailable} left too few ${blocks_[1]} for a p-value)` : ""
      }. Without all ${loo.runs.length} at once: ${runText(loo.together)}.`
    : "The leave-one-out check didn’t finish.";
  out.push({
    kind: "list",
    items: [
      `${mover}’s movement: the largest ${intervals[0]} carries ${pct(f.movement.top1)} of its variation in this window, and the largest 5 carry ${pct(f.movement.top5)}, as concentrated as ${f.movement.effective.toFixed(1)} equal ${intervals[1]} (of ${f.movement.intervals.toLocaleString("en-US")}; it moved in ${f.movement.moves.toLocaleString("en-US")}).`,
      `The test: the most influential ${blocks_[0]} carries ${pct(f.sessions.top1)} of the bootstrap’s score, the top 5 carry ${pct(f.sessions.top5)}, and the top 10 ${pct(f.sessions.top10)}, as concentrated as ${f.sessions.effective.toFixed(1)} equal ${blocks_[1]} (of ${f.sessions.count}). Shown as a description, not part of the warning.`,
      looText,
    ],
  });
  const Unit = blocks_[0].charAt(0).toUpperCase() + blocks_[0].slice(1);
  out.push({
    kind: "table",
    id: "fragility-sessions",
    head: ["#", Unit, "Share of score", "Pushes r", "Without it", "Decision"],
    rows: f.sessions.ranked.map((s, k) => {
      const run = loo?.runs[k];
      return [String(k + 1), sessionText(s.from, s.to, resolution), pct(s.share), s.score > 0 ? "up" : "down", run ? runText(run.test) : "…", run ? `${decision(run.test)}${run.flips ? " (changes)" : ""}` : "…"];
    }),
  });
  out.push({
    kind: "table",
    id: "fragility-hours",
    head: [resolution === "hourly" ? "Hour (New York)" : "Day", variable.kind === "probability" ? "Kalshi change" : "ΔE", "Share", "Pushes r", `${Unit} rank`],
    rows: f.hours.map((h) => [intervalText(h.t, resolution), formatSigned(h.kalshiChange, 2, ` ${variable.unit}`), pct(h.share), h.contribution > 0 ? "up" : "down", `#${h.sessionRank}`]),
    note: `Each ${intervals[0]}’s stock return is left out of this report (the page shows it).`,
  });
  out.push(
    p(
      `Diagnostics, not tests: they say how much this result rests on a few ${intervals[1]}, not whether it’s right. Shares are each ${intervals[0]}’s part of ${mover}’s variation and each ${blocks_[0]}’s part of the bootstrap score’s variance; “as concentrated as” counts are Kish’s effective numbers. The warning uses thresholds fixed before any results were seen: fewer than ${FRAGILE.minEffectiveMoves} equal ${intervals[1]} of movement, or a decision at 5% that changes when one of the ${FRAGILE.leaveOut} most influential ${blocks_[1]} is left out (alpha and beta refitted without it). A p-value near 0.05 can also cross it from Monte Carlo error alone (about ±0.007 with ${(primary.resampling?.draws ?? 999).toLocaleString("en-US")} draws). It comes on by chance too: in hourly simulations with no real relationship, it came on in ${WARNING_BY_CHANCE}.`,
    ),
  );
  out.push(
    p(
      `Changed on Oct 19, 2026, from the pre-set thresholds: the warning no longer counts fewer than ${DESCRIPTIVE_MIN_SESSIONS} equal ${blocks_[1]}, still shown above as a description. In simulations with no real relationship it came on in ${F2_BY_CHANCE}, so as a warning it carried no information. The change was based only on simulated data.`,
    ),
  );
  return out;
}

/** An event-study average, or why it's left out (fewer than MIN_TEST_EVENTS events in the group). */
const average = (study: EventStudy | null | undefined, group: "rises" | "falls") => {
  if (!study) return "—";
  if (!enough(study[group].n)) return `n < ${MIN_TEST_EVENTS}`;
  return formatSigned(study[group].mean?.at(-1) ?? null, 2, "%");
};

function marketBlocks(i: AnalysisReportInput): Block[] {
  const { results, resolution, sample, variable } = i;
  const market = results.market;
  const settings = SETTINGS[resolution];
  const changes = variable.kind === "probability" ? "Kalshi changes" : "ΔE";
  const bench = i.benchmark;
  const model = market?.model ?? null;
  const flags: string[] = [];
  if (i.isSelf) flags.push(`${i.stock} is the benchmark itself, so its market-adjusted return is always zero.`);
  if (model && model.r2 >= NEAR_DUPLICATE_R2) flags.push(`${bench} explains almost all of ${i.stock}’s moves (R² = ${model.r2.toFixed(2)}): what’s left after adjusting is mostly noise`);
  if (model?.flag === "small") flags.push(`Beta rests on only ${model.n} intervals, so it’s imprecise`);
  const overlap = market?.kalshiVsBenchmark;
  if (overlap && overlap.test.p !== null && overlap.test.p < 0.05) {
    flags.push(`${changes} moved with ${bench}’s returns (r = ${fmtR(overlap.r)}, p = ${formatP(overlap.test.p)}, n = ${overlap.n}; uncorrected): adjusting for ${bench} removes part of what this ${variable.kind === "probability" ? "market" : "event"} tracks`);
  }
  const out: Block[] = [];
  if (flags.length > 0) out.push({ kind: "callout", title: "Market adjustment", items: flags });
  if (!market || !model) {
    if (market && !model) out.push(p(`Not enough data to estimate beta: fewer than 10 ${intervalNoun(resolution)[1]} have prices for both ${i.stock} and ${bench}.`));
    return out;
  }
  out.push({
    kind: "facts",
    rows: [
      ["Beta", `${model.beta.toFixed(2)}${model.betaCi ? ` (95% CI ${model.betaCi[0].toFixed(2)} to ${model.betaCi[1].toFixed(2)})` : ""}`],
      ["R²", `${model.r2.toFixed(2)} of ${i.stock}’s moves explained`],
      ["Alpha", `${formatAlpha(model.alpha)} per ${settings.noun[0]}`],
      ["n", `${model.n.toLocaleString("en-US")} ${intervalNoun(resolution)[1]}, ${sample.kind === "loaded" ? "90 days" : sample.label}`],
    ],
  });
  const pairs = (list: { kalshiChange: number; logReturn: number }[]) => list.map((c) => ({ x: c.kalshiChange, y: c.logReturn }));
  const abnormal = correlationStats(pairs(market.abnormal ?? []));
  const excess = correlationStats(pairs(market.excess));
  const end = formatLag(results.rawStudy.offsets.at(-1)!, settings.unit);
  const row = (label: string, r: number | null, n: number, study: EventStudy | null) => [label, fmtR(r), String(n), average(study, "rises"), average(study, "falls"), formatSigned(study?.baseline.mean?.at(-1) ?? null, 2, "%")];
  out.push({
    kind: "table",
    id: "market-comparison",
    head: ["Returns", `${settings.same} r`, "n", `After rises, ${end}`, `After falls, ${end}`, `Baseline, ${end}`],
    rows: [
      row("Raw", results.rawSame.r, results.rawSame.n, results.rawStudy),
      row("Beta-adjusted", abnormal.r, abnormal.n, market.studies.abnormal),
      row(`Simple excess (${i.stock} − ${bench})`, excess.r, excess.n, market.studies.excess),
    ],
    note: `r: correlation of ${changes} with each kind of return. The last three columns are the event study’s average path by ${end}, left out (n < ${MIN_TEST_EVENTS}) for rises or falls with fewer than ${MIN_TEST_EVENTS} events. Simple excess subtracts ${bench}’s return one for one.${
      market.eventModel ? ` The event study’s beta-adjusted paths use a separate beta, ${market.eventModel.beta.toFixed(2)}, from ${modelSample(market.eventModel, resolution, sample)} leaving out every jump window.` : ""
    }`,
  });
  const fit = market.kalshi;
  if (fit === null) {
    out.push(p("Kalshi, with the market held fixed: not enough intervals with Kalshi movement to fit the regression."));
  } else {
    const pc = (v: number) => formatSigned(v, 3, "%");
    const { test, neweyWest } = fit;
    out.push(
      p(
        `Kalshi, with the market held fixed (exploratory cross-check, uncorrected): with ${bench}’s return held fixed, ${variable.text.perUnit} went with a ${pc(fit.coef)} ${i.stock} return in the same ${settings.noun[0]}${test.ci ? ` (95% CI ${formatCi(test.ci, pc)})` : ""}. ${
          test.p !== null ? `p = ${formatP(test.p)}: ${verdictText(test.p)} from zero at the 5% level.` : (unavailableText(test) ?? "")
        } Over ${plural(fit.n, ["interval", "intervals"])} (${variable.text.subject} moved in ${fit.kalshiMoves}); ${bench}’s coefficient is ${fit.marketCoef.toFixed(2)}.${
          test.p !== null && neweyWest.p !== null && !fit.fewKalshiMoves ? ` The same t read from a t distribution gives p = ${formatP(neweyWest.p)}, a large-sample approximation that can reject too often: ${NEWEY_WEST_NOTE}` : ""
        }`,
      ),
    );
  }
  return out;
}

function leadLagBlocks(i: AnalysisReportInput, adjustment: Adjustment | null): Block[] {
  const { results, resolution, variable } = i;
  const settings = SETTINGS[resolution];
  const lags = results.view.lags;
  const returnNoun = adjustment ? "market-adjusted return" : "return";
  const measured = lags.filter((l) => l.r !== null);
  const family = lags.filter((l) => l.test.role === "exploratory");
  const tested = family.filter((l) => l.test.p !== null);
  const fmt = (l: LagCorrelation) => formatLag(l.lag, settings.unit);
  const passing = tested.filter((l) => passes(l.test, "bh")).sort((a, b) => a.test.p! - b.test.p!);
  const smallest = tested.reduce<LagCorrelation | null>((a, b) => (a === null || b.test.holm! < a.test.holm! ? b : a), null);
  const withMethod = lags.find((l) => l.test.p !== null) ?? lags.find((l) => l.test.pUnavailable === "too_few_blocks");
  const changes = variable.kind === "probability" ? "Kalshi changes" : "ΔE";
  let lead: string;
  if (measured.length === 0) lead = "Not enough matching intervals at any lag to measure a correlation.";
  else if (tested.length === 0) lead = withMethod ? (unavailableText(withMethod.test) ?? "No lag has a p-value.") : "No lag has a p-value.";
  else if (passing.length > 0) {
    const [top, ...others] = passing;
    lead = `After correcting for the ${tested.length} lags tested, ${passing.length === 1 ? "one passes" : `${passing.length} pass`}: at ${fmt(top)}, ${changes} tended to move ${top.r! > 0 ? "in the same direction as" : "opposite to"} ${when(top.lag, settings, `${i.stock}’s ${returnNoun}`)} (r = ${fmtR(top.r)}, 95% CI ${formatCi(top.test.ci, fmtR)}, Holm p = ${formatP(top.test.holm)}, BH p = ${formatP(top.test.bh)}).${others.length > 0 ? ` Also ${others.map(fmt).join(", ")}.` : ""} Exploratory: a lead to check, not a finding.`;
  } else {
    const uncorrected = tested.filter((l) => passes(l.test, "raw"));
    lead = `No lag passes correction for the ${tested.length} tested (smallest Holm-adjusted p: ${formatP(smallest!.test.holm)} at ${fmt(smallest!)}).${
      uncorrected.length > 0 ? ` Uncorrected, ${uncorrected.map((l) => `${fmt(l)} has p = ${formatP(l.test.p)}`).join(" and ")}: about what chance produces across ${tested.length} tests.` : ""
    }`;
  }
  const chart: Block[] =
    measured.length === 0
      ? []
      : [
          {
            kind: "chart",
            id: "lead-lag",
            svg: leadLagChart(
              lags.map((l) => ({ label: fmt(l), r: l.r, ci: l.test.ci, primary: l.test.role === "primary" })),
              `Lead-lag: the correlation of ${changes} with ${i.stock}’s ${returnNoun}s at each lag, with 95% intervals`,
            ),
            alt: `Lead-lag: r at each lag (dots) with its 95% interval (whiskers)`,
            caption: `Correlation of ${changes} with ${i.stock}’s ${returnNoun}s, shifted by ${settings.noun[1]}; right of 0, ${variable.text.subject} moved first. Exploratory; the values are in the table below.`,
          },
        ];
  return [
    p(lead),
    ...chart,
    {
      kind: "table",
      id: "lead-lag",
      head: ["Lag", ...TEST_COLUMNS.map((c) => (c === "Estimate" ? "r" : c === "n" ? "Pairs" : c))],
      rows: lags.map((l) => [fmt(l) + (l.test.role === "primary" ? " (primary)" : ""), ...testCells(l.test, fmtR)]),
      note: `Positive lags: ${variable.text.subject} moved first; negative: ${i.stock} moved first. Exploratory: corrected as one family, the ${family.length} exploratory lags${adjustment ? " (lag 0 is the primary test, judged on its own)" : ""}. Neighboring lags share most of their data, which makes Holm cautious. ${
        withMethod && withMethod.test.p !== null ? methodText(withMethod.test) : ""
      } ${variable.text.sign}${adjustment ? ` ${adjustmentNote(adjustment, i.stock, resolution)}` : ""}`.replace(/\s+/g, " ").trim(),
    },
  ];
}

function rollingBlocks(i: AnalysisReportInput, adjustment: Adjustment | null): Block[] {
  const settings = SETTINGS[i.resolution];
  const w = settings.rollingWindow;
  const points = i.results.view.rolling;
  const rs = points.map((x) => x.r).filter((r): r is number => r !== null);
  const changes = i.results.view.changes.length;
  const has = changes >= w + ROLLING_EXTRA && rs.length > 0;
  const latest = points.at(-1)?.r ?? null;
  const chart: Block[] = has
    ? [
        {
          kind: "chart",
          id: "rolling",
          svg: rollingChart(points, `Rolling ${settings.same.toLowerCase()} correlation over time`, formatShortDate),
          alt: "Rolling correlation over time",
          caption: "Descriptive only: each point is the correlation over the intervals just before it.",
        },
      ]
    : [];
  return [
    ...chart,
    p(
      has
        ? `The ${settings.same.toLowerCase()} correlation over the last ${w} intervals (${settings.rollingSpan})${adjustment ? `, market-adjusted vs. ${adjustment.benchmark}` : ""} moved from ${fmtR(Math.min(...rs))} to ${fmtR(Math.max(...rs))} (latest ${fmtR(latest)}).`
        : `Not enough data for a rolling view: it needs at least ${w + ROLLING_EXTRA} usable intervals; this window has ${changes}.`,
    ),
    p(`Descriptive only: no significance is claimed. Each point uses just ${w} intervals and shares ${w - 1} of them with the next, so its swings aren’t independent evidence.`),
  ];
}

function eventBlocks(i: AnalysisReportInput, adjustment: Adjustment | null): Block[] {
  const { resolution, variable, threshold } = i;
  const settings = SETTINGS[resolution];
  const study: EventStudy | null = i.results.view.study;
  const tests: EventStudyTests | null = i.results.view.events;
  const kind = adjustment ? "market-adjusted return" : "return";
  const intro = p(`Average ${i.stock} cumulative ${kind} in the ${settings.noun[1]} before and after ${variable.text.moved} moved ≥${threshold} ${variable.unit} in one ${settings.noun[0]}.`);
  if (study === null || tests === null) {
    return [intro, p(`Not enough data for a market-adjusted event study: fewer than 10 ${resolution} intervals in the market model’s sample fall outside the jump windows, so beta can’t be estimated without the jumps shaping it.`)];
  }
  const last = study.offsets.length - 1;
  const end = formatLag(study.offsets[last], settings.unit);
  const at = (mean: number[] | null) => formatSigned(mean?.[last] ?? null, 2, "%");
  const groups = [
    { name: "rises", key: "rises" as const },
    { name: "falls", key: "falls" as const },
  ];
  const flags = [eventFlag("rise", tests.rises, study.rises.n), eventFlag("fall", tests.falls, study.falls.n)].filter((f): f is string => f !== null);
  const shown = groups.filter((g) => enough(study[g.key].n));
  const parts = shown.map((g) => `after ${g.name}, ${i.stock} averaged ${at(study[g.key].mean)}`);
  const paths = shown
    .map((g) => {
      const t = tests[g.key].path;
      return t.p === null ? null : `after ${g.name}, p = ${formatP(t.p)} (Holm ${formatP(t.holm)}, BH ${formatP(t.bh)})`;
    })
    .filter(Boolean);
  const out: Block[] = [intro];
  if (flags.length > 0) out.push({ kind: "callout", title: "Few events", items: flags });
  out.push(
    p(
      `Based on ${plural(study.rises.n, ["rise", "rises"])} and ${plural(study.falls.n, ["fall", "falls"])} ${variable.text.movesIn}. Compare each path with the baseline (the stock’s normal drift over any window this long), not with zero.${
        parts.length > 0 ? ` By ${end}, ${parts.join("; ")}, vs. ${at(study.baseline.mean)} for the baseline.` : ""
      }${paths.length > 0 ? ` Whole path against the baseline: ${paths.join("; ")}.` : ""}`,
    ),
  );
  const omitted = groups.filter((g) => !enough(study[g.key].n) && study[g.key].n > 0);
  if (omitted.length > 0) {
    out.push(p(`The average path after ${omitted.map((g) => g.name).join(" and ")} is left out of this report: with fewer than ${MIN_TEST_EVENTS} events it is close to a single event’s returns.`));
  }
  if (shown.length > 0) {
    const base = study.baseline.mean;
    out.push({
      kind: "chart",
      id: "event-study",
      svg: eventStudyChart(
        {
          labels: study.offsets.map((k) => formatLag(k, settings.unit)),
          groups: shown.map((g) => ({
            name: `After ${g.name} (n = ${study[g.key].n})`,
            mean: study[g.key].mean ?? [],
            band: tests[g.key].bars.map((t, k) => (t?.ci && base ? ([t.ci[0] + base[k], t.ci[1] + base[k]] as [number, number]) : null)),
          })),
          baseline: base ?? [],
        },
        `Average ${i.stock} cumulative ${kind} around ${variable.kind === "probability" ? "Kalshi jumps" : "jumps in E"}, with 95% bands and the baseline`,
      ),
      alt: `Average cumulative ${kind} after ${shown.map((g) => g.name).join(" and ")}, with 95% bands, against the baseline`,
      caption: "Compare each path with the baseline (gray), not with zero. Shaded: 95% intervals for the average path. Paths of groups with too few events to average are left out.",
    });
    const pc = (v: number) => formatSigned(v, 2, "%");
    const cell = (t: TestResult | null) => (t === null ? ["—", "—", "—"] : [t.estimate === null ? "—" : pc(t.estimate), formatCi(t.ci, pc), t.p === null ? "—" : `${formatP(t.p)} (${formatP(t.bh)})`]);
    const label = (name: string) => name.charAt(0).toUpperCase() + name.slice(1);
    out.push({
      kind: "table",
      id: "event-study",
      head: ["Bar", ...shown.flatMap((g) => [`${label(g.name)} vs. baseline`, `${label(g.name)} 95% CI`, `${label(g.name)} p (BH)`]), "Baseline"],
      rows: study.offsets.map((k, j) => [formatLag(k, settings.unit), ...shown.flatMap((g) => cell(tests[g.key].bars[j])), formatSigned(study.baseline.mean?.[j] ?? null, 2, "%")]),
    });
  }
  const method = [tests.rises.path, tests.falls.path].find((t) => t.p !== null);
  out.push(
    p(
      `Exploratory. ${eventFamilyText(tests)} Each bar’s test asks whether the paths after jumps differ from the baseline; the whole-path test whether they differ anywhere in the window. ${method ? methodText(method) : ""} Paths start at the close before the jump (bar −1). ${settings.barNote}`.replace(/\s+/g, " ").trim(),
    ),
  );
  return out;
}

function results(i: AnalysisReportInput): Section[] {
  const { results: r } = i;
  const market = r.market;
  const adjustment: Adjustment | null =
    r.shown === "adjusted" && market?.model
      ? { benchmark: i.benchmark, model: market.model, eventModel: market.eventModel, missingBenchmark: market.missingBenchmark, sample: i.sample }
      : null;
  const primary = market?.primary ?? null;
  const sections: Section[] = [
    { id: "summary", title: "Results: the sample", blocks: summary(i, adjustment) },
    { id: "primary", title: "Results: primary test", blocks: primaryBlocks(i) },
  ];
  if (primary && r.fragility) sections.push({ id: "fragility", title: "Results: how much it rests on a few intervals", blocks: fragilityBlocks(i, r.fragility, i.leaveOneOut, primary) });
  sections.push({ id: "market", title: "Results: market adjustment", blocks: marketBlocks(i) });
  if (r.view.changes.length === 0) {
    sections.push({ id: "exploratory", title: "Results: exploratory", blocks: [p("No intervals have a usable Kalshi value and stock price at both ends, so there is nothing more to analyze in this window.")] });
    return sections;
  }
  sections.push({ id: "lead-lag", title: "Results: lead-lag (exploratory)", blocks: leadLagBlocks(i, adjustment) });
  sections.push({ id: "rolling", title: "Results: rolling correlation (descriptive)", blocks: rollingBlocks(i, adjustment) });
  sections.push({ id: "event-study", title: `Results: around ${i.variable.kind === "probability" ? "Kalshi jumps" : "jumps in E"} (exploratory)`, blocks: eventBlocks(i, adjustment) });
  return sections;
}

export function reproducibilitySection(frozenAt: number | null, extra: string[] = []): Section {
  return {
    id: "reproducibility",
    title: "Reproducibility",
    blocks: [
      p(
        frozenAt !== null
          ? `This report’s link is frozen as of ${reportInstant(frozenAt)}: opening it later recomputes these numbers from the same data, as far as the points below allow.`
          : "This report’s link isn’t frozen: opening it later gives the numbers as of then. Freeze the view before exporting to get a link that reproduces these.",
      ),
      p("The same every time, given the same data:"),
      { kind: "list", items: REPRODUCED },
      p("What can still change:"),
      { kind: "list", items: [...MAY_DIFFER, ...extra] },
    ],
  };
}

export function caveatsSection(lines: string[]): Section {
  return {
    id: "caveats",
    title: "Caveats",
    blocks: [{ kind: "list", items: [...lines, "Correlation, not causation: these figures describe how the series moved together in this sample. They are not predictions or trading signals. Other news can move both at once."] }, p(DISCLAIMER)],
  };
}

/** The report for one analysis, as its panel shows it. */
export function analysisReport(i: AnalysisReportInput): Report {
  const sign =
    i.variable.kind === "expected"
      ? `How to read the sign: positive means ${i.stock} tended to rise when ${i.variable.text.rose}; negative, that it tended to fall.`
      : `How to read the sign: positive means ${i.stock} tended to rise when the chance of YES rose. Here, YES = “${i.variable.yesLabel}”. If YES is bad news for ${i.stock}, negative values are what you’d expect.`;
  return {
    title: `${i.stock} vs. ${i.kalshi}`,
    kind: "EventLens analysis report",
    preparedBy: i.preparedBy,
    sections: [
      question(i),
      inputs(i),
      sources(i),
      methods(i),
      ...results(i),
      reproducibilitySection(i.frozenAt),
      caveatsSection([
        sign,
        "Only the primary test is a confirmatory question; everything else is exploratory and corrected only within its own chart. Switching window, resolution, or benchmark until something looks significant isn’t corrected for.",
      ]),
    ],
    footer: { version: i.version, commit: i.commit, link: i.link, generatedAt: i.generatedAt },
  };
}

/** A file name for an analysis's report: eventlens-report_TLT_KXFEDDECISION-26DEC_90d-hourly_2026-10-25. */
export function analysisFileBase(i: Pick<AnalysisReportInput, "stock" | "kalshi" | "choice" | "resolution" | "asOf">): string {
  return `eventlens-report_${i.stock}_${i.kalshi}_${i.choice === "all" ? "all" : `${i.choice}d`}-${i.resolution}_${new Date(i.asOf).toISOString().slice(0, 10)}`;
}
