// Fixtures and checks for the bottom-line summary's tests: real panel results from simulated rows,
// with the parts each rating rule reads swapped for hand-made ones, the language checks (trading
// words, sentence length, reading level), and reading a rendered card back part by part.

import type { DetectableCorrelation, TestResult } from "@/lib/analytics";
import type { Fragility, LeaveOneOut } from "@/lib/analytics/fragility";
import { leaveOneOut } from "@/lib/analytics/fragility";
import { panelCore, panelEvents, panelResults, type PanelInput, type PanelResults, type Returns } from "@/lib/analytics/panel";
import { lastSessions, simulateMarketRows } from "@/lib/analytics/test-helpers";
import { expectedVariable, probabilityVariable } from "@/lib/analytics/variable";
import type { Section } from "@/lib/report/model";
import { tileText } from "../report/bottomLineReport";
import { textOf } from "../report/test-helpers";
import { fmtR } from "../research/parts";
import { formatCi } from "../research/stats";
import { GAUGE_SCALE, valueAt, type GaugeSize } from "./gauge";
import type { BottomLineInput, BottomLine } from "./summary";
import { NOT_ADVICE } from "./summary";

export const MARKET = probabilityVariable("Fed maintains rate");
export const EVENT = expectedVariable({ unit: "bp", label: "the expected rate change" });

/** One window's panel results from simulated hourly rows, as the panel computes them, with its leave-one-out check (62 sessions simulated, or the window's own when it's longer). */
export function simulated({ seed = 4_242, effect = 0, window = 62, returns = "adjusted" as Returns } = {}): { results: PanelResults; loo: LeaveOneOut | null } {
  const { rows: full, closesByT } = simulateMarketRows({ sessions: Math.max(62, window), resolution: "hourly", seed, effect, sharedVolatility: true, kalshiInMarket: 0.1 });
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

export function bottomLineInput(results: PanelResults, over: Partial<BottomLineInput> = {}): BottomLineInput {
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

/** The gauge's words: its line, note, and spoken label, or why there's none. */
export const gaugeText = (s: BottomLine): string[] => (!s.gauge ? [] : s.gauge.drawn ? [s.gauge.line, s.gauge.note, s.gauge.label] : [s.gauge.why]);

/** Everything the summary says, as one text: the question, the answer, the gauge, the tiles, and every section's title and items. */
export const summaryText = (s: BottomLine) =>
  [s.question, s.verdict, s.headline, ...gaugeText(s), ...s.tiles.flatMap((t) => [t.label, t.value, t.note]), s.why, ...s.sections.flatMap((x) => [x.title, ...x.items])].join("\n");

// ---- Language ----

/** Trading words (and their forms), matched as whole words, any case. */
export const BANNED = /\b(buy(s|ing)?|sell(s|ing)?|signal(s|ed|ing|led|ling)?|opportunit(y|ies)|recommend(s|ed|ing|ation|ations)?|profit(s|able|ably|ability)?)\b|\bshould\s+invest/gi;

/** "Odds" isn't what a Kalshi price says: its prices are probabilities, so the wording says "chance". */
export const ODDS = /\bodds\b/gi;

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

/** A tile read back from the card as a report writes it: "How sure? Weak. Fragile result." */
function tileLine(_: string, label: string, value: string, note: string): string {
  const name = plainText(label);
  return `<p>${tileText({ id: name === "Tested" ? "tested" : "sure", label: name, value: plainText(value), note: plainText(note) })}</p>`;
}

/**
 * The card's parts in reading order, with the folded reasons, as a report lists them: its paragraphs,
 * tiles, list items, and headings, and a fold's title as a heading. Less the card's own title and its
 * folded glossary, which a report keeps in its last section.
 */
export function cardParts(card: string): string[] {
  const body = card
    .replace(/<details\b[^>]*><summary\b[^>]*>What the terms mean[\s\S]*?<\/details>/, "")
    .replace(/<div class="[^"]*"><dt\b[^>]*>([\s\S]*?)<\/dt><dd\b[^>]*>([\s\S]*?)<\/dd><dd\b[^>]*>([\s\S]*?)<\/dd><\/div>/g, tileLine);
  return [...body.matchAll(/<(h2|h3|h4|p|li|summary)\b[^>]*>([\s\S]*?)<\/\1>/g)]
    .map((m) => plainText(m[2]))
    .filter((part) => part !== "" && part !== "The bottom line");
}

/** A report section's parts in order: its headings, paragraphs, list items, and a chart's caption (the gauge's line). */
export function reportParts(section: Section): string[] {
  return section.blocks
    .flatMap((b) => (b.kind === "list" ? b.items : b.kind === "paragraph" || b.kind === "heading" ? [b.text] : b.kind === "chart" ? [b.caption] : []))
    .map(plainText);
}

/** A rating's line: the card's badge, or a report's "Evidence:" line. They sit in different places, so they're compared apart. */
export const isEvidenceLine = (part: string) => part.startsWith("Evidence: ");

/** The glossary as the card's "What the terms mean" lists it: "Term: definition". */
export const cardGlossary = (card: string) => [...card.matchAll(/<div><dt\b[\s\S]*?<\/dd><\/div>/g)].map(([d]) => plainText(d));

// ---- Reading a gauge back from its drawing ----

/** What a card's gauge draws, read back from its coordinates: the values its needle and band ends stand for, and its label. */
export function drawnGauge(card: string): { size: GaugeSize; label: string; r: number; band: [number, number] | null; arrows: string[] } | null {
  const svg = /<svg [^>]*data-gauge="(full|compact)"[\s\S]*?<\/svg>/.exec(card);
  if (!svg) return null;
  const size = svg[1] as GaugeSize;
  const needle = /<line x1="[\d.]+" y1="[\d.]+" x2="([\d.]+)" y2="([\d.]+)"[^>]*data-part="needle"/.exec(svg[0]);
  if (!needle) throw new Error("expected the gauge's needle");
  const band = /<path d="M([\d.]+) ([\d.]+)A[\d.]+ [\d.]+ 0 0 1 ([\d.]+) ([\d.]+)"[^>]*data-part="band"/.exec(svg[0]);
  const at = (x: string, y: string) => valueAt(size, { x: Number(x), y: Number(y) });
  return {
    size,
    label: textOf(/aria-label="([^"]*)"/.exec(svg[0])![1]),
    r: at(needle[1], needle[2]),
    band: band ? [at(band[1], band[2]), at(band[3], band[4])] : null,
    arrows: [...svg[0].matchAll(/data-part="arrow-(low|high)"/g)].map((m) => m[1]),
  };
}

const onScale = (v: number) => Math.max(-GAUGE_SCALE, Math.min(GAUGE_SCALE, v));
/** A drawn value is the given one, to within the drawing's rounding to 0.1 units. */
const DRAWN = 1e-3;

/**
 * The card's gauge draws exactly the primary test the page holds, and says the numbers the page prints
 * outside the card: the needle at its r and the band's ends at its range (at the scale's edge, with an
 * arrow, past it), and the label's r and range as the page writes them. Throws when they differ.
 */
export function expectGaugeMatchesPage(card: string, page: string, test: { estimate: number | null; ci: [number, number] | null } | null) {
  const g = drawnGauge(card);
  if (!test || test.estimate === null) {
    if (g) throw new Error("a gauge drawn without a correlation");
    return;
  }
  if (!g) throw new Error("expected the gauge");
  const { estimate: r, ci } = test;
  const near = (drawn: number, value: number, what: string) => {
    if (!(Math.abs(drawn - onScale(value)) < DRAWN)) throw new Error(`${what}: drawn at ${drawn}, the page's is ${value}`);
  };
  near(g.r, r, "needle");
  const printed = [fmtR(r), ...(ci ? [formatCi(ci, fmtR)] : [])];
  for (const text of printed) {
    if (!page.includes(text)) throw new Error(`the page doesn't print ${text}`);
  }
  if (!g.label.includes(`r = ${printed[0]}`) || (ci && !g.label.includes(`95% range ${printed[1]}`))) throw new Error(`the label's numbers aren't the page's: ${g.label}`);
  const edges = new Set<string>();
  if (Math.abs(r) > GAUGE_SCALE) edges.add(r < 0 ? "low" : "high");
  if (ci) {
    const allPast = ci[1] < -GAUGE_SCALE || ci[0] > GAUGE_SCALE;
    if (allPast !== (g.band === null)) throw new Error("the band is drawn when all of the range is past the scale, or missing when it isn't");
    if (g.band) {
      near(g.band[0], ci[0], "band's low end");
      near(g.band[1], ci[1], "band's high end");
    }
    if (ci[0] < -GAUGE_SCALE) edges.add("low");
    if (ci[1] > GAUGE_SCALE) edges.add("high");
  } else if (g.band) throw new Error("a band drawn without a range");
  if ([...edges].sort().join() !== [...g.arrows].sort().join()) throw new Error(`arrows at ${g.arrows.join()} for values past ${[...edges].join()}`);
}
