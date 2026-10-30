// Fixtures and checks for the plain-English summary's tests: real panel results from simulated rows,
// with the parts each rating rule reads swapped for hand-made ones, the language checks (trading
// words, sentence length, reading level), and reading a rendered card back part by part.

import type { DetectableCorrelation, TestResult } from "@/lib/analytics";
import type { Fragility, LeaveOneOut } from "@/lib/analytics/fragility";
import { leaveOneOut } from "@/lib/analytics/fragility";
import { panelCore, panelEvents, panelResults, type PanelInput, type PanelResults, type Returns } from "@/lib/analytics/panel";
import { lastSessions, simulateMarketRows } from "@/lib/analytics/test-helpers";
import { expectedVariable, probabilityVariable } from "@/lib/analytics/variable";
import type { Section } from "@/lib/report/model";
import { textOf } from "../report/test-helpers";
import type { PlainInput, PlainSummary } from "./summary";
import { NOT_ADVICE } from "./summary";

export const MARKET = probabilityVariable("Fed maintains rate");
export const EVENT = expectedVariable({ unit: "bp", label: "the expected rate change" });

/** One window's panel results from simulated hourly rows, as the panel computes them, with its leave-one-out check. */
export function simulated({ seed = 4_242, effect = 0, window = 62, returns = "adjusted" as Returns } = {}): { results: PanelResults; loo: LeaveOneOut | null } {
  const { rows: full, closesByT } = simulateMarketRows({ sessions: 62, resolution: "hourly", seed, effect, sharedVolatility: true, kalshiInMarket: 0.1 });
  const first = lastSessions(full, window, "hourly")[0].t;
  const input: PanelInput = { full, from: first - 1, resolution: "hourly", scale: 100, closes: [...closesByT].map(([t, value]) => ({ t, value })), returns };
  const core = panelCore(input);
  const results = panelResults(core, panelEvents(input, core, 2));
  const primary = results.market?.primary;
  const changes = results.series.changes;
  const loo =
    primary && results.fragility ? leaveOneOut({ full, closesByT, changes, resolution: "hourly", primary, fragility: results.fragility, draws: 199 }) : null;
  return { results, loo };
}

/** A primary test with these numbers, in the panel's shape. */
export function primaryWith(base: TestResult, over: Partial<TestResult>): TestResult {
  return { ...base, ...over };
}

/** The results with the primary test, the diagnostics, or the regression swapped. */
export function withParts(results: PanelResults, { primary, fragility, kalshi }: { primary?: TestResult; fragility?: Fragility | null; kalshi?: Partial<NonNullable<NonNullable<PanelResults["market"]>["kalshi"]>> | null }): PanelResults {
  const market = results.market!;
  return {
    ...results,
    fragility: fragility === undefined ? results.fragility : fragility,
    market: {
      ...market,
      primary: primary ?? market.primary,
      kalshi: kalshi === null ? null : kalshi === undefined ? market.kalshi : { ...market.kalshi!, ...kalshi, test: { ...market.kalshi!.test, ...(kalshi.test ?? {}) } },
    },
  };
}

export const fragilityWith = (f: Fragility, effective: number): Fragility => ({ ...f, movement: { ...f.movement, effective } });
export const looWith = (loo: LeaveOneOut, flips: number): LeaveOneOut => ({ ...loo, flips });
export const detectableAt = (r: number | null): DetectableCorrelation => ({ r, max: 0.8, slope: null, power: 0.8, samples: 999, unit: "session", units: 62 });

export function plainInput(results: PanelResults, over: Partial<PlainInput> = {}): PlainInput {
  return {
    stock: "TLT",
    variable: MARKET,
    choice: 90,
    resolution: "hourly",
    benchmark: "SPY",
    unavailable: "Too few prices to estimate beta",
    results,
    detectable: detectableAt(0.25),
    leaveOneOut: undefined,
    longDaily: false,
    windowNote: null,
    sources: { provenance: null },
    windowEnd: null,
    windowFrozen: false,
    frozenAt: null,
    ...over,
  };
}

/** Everything the summary says, as one text: the headline and every section's items. */
export const summaryText = (s: PlainSummary) => [s.headline, ...s.sections.flatMap((x) => x.items)].join("\n");

// ---- Language ----

/** Trading words (and their forms), matched as whole words, any case. */
export const BANNED = /\b(buy(s|ing)?|sell(s|ing)?|signal(s|ed|ing|led|ling)?|opportunit(y|ies)|recommend(s|ed|ing|ation|ations)?|profit(s|able|ably|ability)?)\b|\bshould\s+invest/gi;

/** Trading words in a text, after removing the one sentence allowed to name them (NOT_ADVICE). */
export function bannedIn(text: string): string[] {
  return [...text.split(NOT_ADVICE).join(" ").matchAll(BANNED)].map((m) => m[0]);
}

/** Sentences: split at ., ?, or ! followed by a space or the end (not inside 0.034). Line breaks end one too. */
export function sentences(text: string): string[] {
  return text
    .split(/\n+/)
    .flatMap((line) => line.split(/(?<=[.?!…])\s+/))
    .map((s) => s.trim())
    .filter((s) => /[A-Za-z]/.test(s));
}

/**
 * Words, with a quoted Kalshi label or title, a ticker, and a number each counted as one plain word:
 * "the chance of “Fed maintains rate”" is four words of one syllable each, beyond "chance".
 */
export function plainWords(sentence: string): string[] {
  return sentence
    .replace(/“[^”]*”/g, " label ")
    .split(/\s+/)
    .map((w) => w.replace(/^[^A-Za-z0-9±+−-]+|[^A-Za-z0-9%]+$/g, ""))
    .filter((w) => /[A-Za-z0-9]/.test(w))
    .map((w) => (/^[A-Z0-9-]{2,}$/.test(w) || /\d/.test(w) ? "one" : w));
}

/** A rough syllable count: groups of vowels, less a silent final e; hyphenated words count each part. */
export function syllables(word: string): number {
  return word
    .toLowerCase()
    .split("-")
    .filter(Boolean)
    .reduce((sum, part) => {
      const w = part.replace(/[^a-z]/g, "");
      if (w.length <= 3) return sum + 1;
      const trimmed = w.replace(/(?:[^laeiouy]es|ed|[^laeiouy]e)$/, "").replace(/^y/, "");
      return sum + Math.max(1, (trimmed.match(/[aeiouy]{1,2}/g) ?? []).length);
    }, 0);
}

/** Flesch–Kincaid grade level: 0.39 × words per sentence + 11.8 × syllables per word − 15.59. */
export function gradeLevel(text: string): number {
  const ss = sentences(text);
  const words = ss.flatMap(plainWords);
  const syl = words.reduce((sum, w) => sum + syllables(w), 0);
  return 0.39 * (words.length / ss.length) + 11.8 * (syl / words.length) - 15.59;
}

/** The longest sentence's word count, and the sentence. */
export function longest(text: string): { words: number; sentence: string } {
  return sentences(text).reduce((best, s) => {
    const n = plainWords(s).length;
    return n > best.words ? { words: n, sentence: s } : best;
  }, { words: 0, sentence: "" });
}

// ---- Reading a rendered card back ----

/** Text without its markup: glossary markers and hidden labels read as the words they hold. */
export const plainText = (html: string) => textOf(html.replace(/<[^>]+>/g, ""));

/** The card's parts in reading order (headings, paragraphs, list items), less its header and its folded notes. */
export function cardParts(card: string): string[] {
  const body = card.replace(/<header[\s\S]*?<\/header>/, "").replace(/<details[\s\S]*?<\/details>/g, "");
  return [...body.matchAll(/<(h3|p|li)\b[^>]*>([\s\S]*?)<\/\1>/g)].map((m) => plainText(m[2]));
}

/** A report section's parts in order: its headings, paragraphs, and list items. */
export function reportParts(section: Section): string[] {
  return section.blocks.flatMap((b) => (b.kind === "list" ? b.items : b.kind === "paragraph" || b.kind === "heading" ? [b.text] : [])).map(plainText);
}

/** The glossary as the card's "What the terms mean" lists it: "Term: definition". */
export const cardGlossary = (card: string) => [...card.matchAll(/<div><dt\b[\s\S]*?<\/dd><\/div>/g)].map(([d]) => plainText(d));
