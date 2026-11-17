import { describe, expect, it } from "vitest";
import { sectionText } from "@/lib/report/model";
import { bottomLineSection, signalBlocks, termsSection } from "../report/bottomLineReport";
import { GLOSSARY } from "./glossary";
import { analysisScenarios, scanScenarios, signalScenarios } from "./scenarios";
import { DECIDED, HOLD, leanLabel, SCAN_NO_SIGNAL, SIGNAL_DISCLAIMER } from "./signal";
import { RATING_METHOD, SCAN_NOT_ADVICE } from "./summary";
import { bannedIn, cardText, gradeLevel, longest, ODDS, sentences, signalBannedIn, signalText, summaryText } from "./test-helpers";

// The bottom-line summary never uses trading language outside its experimental signal, and the signal
// names buying, selling, or holding only in its exact labels ("Leans Buy vs. SPY", "Leans Sell vs.
// SPY", "Hold: no signal"); promises and advice ("profit", "guaranteed", "recommend", "should") are
// banned everywhere. Changed on purpose on 2026-11-16 (feat/signal), at the user's request: the old
// "not a recommendation to buy or sell" sentence is gone, replaced by the signal's disclaimer. It stays
// short and simple: no sentence over 25 words, and a Flesch–Kincaid grade of at most 9 (numbers,
// tickers, and quoted Kalshi labels count as one plain word each). Every wording path is checked
// (scenarios.ts): each rating rule and each signal rule for a market and an event at six settings, a
// scan in every state, the glossary, and how the rating works, and the same in a report's "The bottom
// line" and "Terms used" sections.

const MAX_WORDS = 25;
const MAX_GRADE = 9;
const analyses = [...analysisScenarios(), ...signalScenarios()];
const scans = scanScenarios();
const scenarios = [...analyses, ...scans];
const report = (s: (typeof scenarios)[number]) => sectionText(bottomLineSection(s.summary, { method: !s.name.startsWith("scan ") }));

describe("the bottom-line summary's language", () => {
  it("covers every wording path, the signal's rules included", () => {
    expect(scenarios.length).toBeGreaterThan(450);
    const levels = new Set(scenarios.map((s) => s.summary.level));
    for (const level of ["not_enough_data", "no_clear_link", "nothing_stood_out", "weak", "moderate", "strong", "pending", "none"]) expect(levels).toContain(level);
    const rules = new Set(analyses.map((s) => s.summary.signal!.rule));
    expect([...rules].sort()).toEqual(["badge", "both_ways", "lean", "no_adjusted", "no_lead", "no_move", "no_p", "pending", "too_late", "weak_lead"]);
    const labels = new Set(analyses.map((s) => s.summary.signal!.label));
    expect([...labels].sort()).toEqual(["buy", "hold", "pending", "sell"]);
    for (const s of scans) expect(s.summary.signal, s.name).toBeNull();
  });

  it("never uses trading language outside the signal, nor promises or advice anywhere", () => {
    for (const s of scenarios) expect(bannedIn(summaryText(s.summary)), s.name).toEqual([]);
    for (const s of analyses) expect(signalBannedIn(signalText(s.summary.signal), s.input!.benchmark), s.name).toEqual([]);
    for (const e of GLOSSARY) expect(bannedIn(`${e.term} ${e.definition}`), e.id).toEqual([]);
    expect(bannedIn(RATING_METHOD.join(" "))).toEqual([]);
  });

  it("names the benchmark in a lean's label, and holds or checks otherwise", () => {
    for (const s of analyses) {
      const { label, text } = s.summary.signal!;
      const expected = label === "buy" || label === "sell" ? leanLabel(label, s.input!.benchmark) : label === "hold" ? HOLD : "Checking…";
      expect(text, s.name).toBe(expected);
    }
    const qqq = analyses.filter((s) => s.name.endsWith("vs. QQQ"));
    expect(qqq.map((s) => s.summary.signal!.text)).toEqual(["Leans Buy vs. QQQ", "Leans Buy vs. QQQ"]);
  });

  it("says “chance”, never “odds”: Kalshi’s prices are probabilities", () => {
    for (const s of scenarios) expect(cardText(s.summary).match(ODDS), s.name).toBeNull();
    for (const e of GLOSSARY) expect(`${e.term} ${e.definition}`.match(ODDS), e.id).toBeNull();
    expect(RATING_METHOD.join(" ").match(ODDS)).toBeNull();
    for (const s of scenarios) expect(report(s).match(ODDS), s.name).toBeNull();
    expect("The Odds of it".match(ODDS)).toEqual(["Odds"]);
  });

  it("is the same in reports: their bottom-line and terms sections add only headings and the level", () => {
    for (const s of scenarios) {
      const text = report(s);
      // The signal's blocks are checked by its own rules, the rest of the section by the general ones.
      const rest = sectionText(bottomLineSection({ ...s.summary, signal: null }, { method: !s.name.startsWith("scan ") }));
      expect(bannedIn(rest), s.name).toEqual([]);
      if (s.summary.signal) expect(signalBannedIn(sectionText({ id: "signal", title: "", blocks: signalBlocks(s.summary.signal) }), s.input!.benchmark), s.name).toEqual([]);
      expect(text.split(s.summary.signal ? SIGNAL_DISCLAIMER : SCAN_NOT_ADVICE).length - 1, s.name).toBe(1);
      expect(longest(text).words, `${s.name}: ${longest(text).sentence}`).toBeLessThanOrEqual(MAX_WORDS);
    }
    expect(bannedIn(sectionText(termsSection()))).toEqual([]);
  });

  it("says its disclaimer once, word for word: the signal's on an analysis, and on a scan that it isn't a prediction or advice, with no signal", () => {
    for (const s of analyses) expect(cardText(s.summary).split(SIGNAL_DISCLAIMER).length - 1, s.name).toBe(1);
    for (const s of scans) {
      expect(summaryText(s.summary).split(SCAN_NOT_ADVICE).length - 1, s.name).toBe(1);
      expect(summaryText(s.summary).split(SCAN_NO_SIGNAL).length - 1, s.name).toBe(1);
    }
    // The old sentence is gone everywhere.
    for (const s of scenarios) expect(cardText(s.summary), s.name).not.toMatch(/recommendation/i);
  });

  it(`keeps every sentence to ${MAX_WORDS} words and every card at grade ${MAX_GRADE} or below`, () => {
    for (const s of scenarios) {
      const text = cardText(s.summary);
      expect(longest(text).words, `${s.name}: ${longest(text).sentence}`).toBeLessThanOrEqual(MAX_WORDS);
      expect(gradeLevel(text), s.name).toBeLessThanOrEqual(MAX_GRADE);
    }
    for (const text of [...GLOSSARY.map((e) => e.definition), RATING_METHOD.join(" "), DECIDED, SIGNAL_DISCLAIMER, SCAN_NO_SIGNAL]) {
      expect(longest(text).words, longest(text).sentence).toBeLessThanOrEqual(MAX_WORDS);
      expect(gradeLevel(text), text).toBeLessThanOrEqual(MAX_GRADE);
    }
  });
});

describe("the language checks themselves", () => {
  it("catch every banned word and its forms, in any case, as whole words", () => {
    const caught = bannedIn("Buy now. Buying, sells, SELLING. Hold; holding. A signal; signals. Opportunity, opportunities. We recommend; a recommendation. Profit, profitable. Guaranteed. You should invest.");
    expect(caught.map((w) => w.toLowerCase())).toEqual([
      "buy",
      "buying",
      "sells",
      "selling",
      "hold",
      "holding",
      "signal",
      "signals",
      "opportunity",
      "opportunities",
      "recommend",
      "recommendation",
      "profit",
      "profitable",
      "guaranteed",
      "should",
    ]);
  });

  it("leave alone words that only contain them, the plain uses of “hold”, and the scan's one sentence about the signal", () => {
    expect(bannedIn("A weak sign, a buyer’s guide, a seller, signed, investment, trading days, a household, shoulder.")).toEqual([]);
    expect(bannedIn("No benchmark to hold fixed. Ranges hold the true value. This window holds only 5 days.")).toEqual([]);
    expect(bannedIn(`${SCAN_NO_SIGNAL} Other news.`)).toEqual([]);
    // Any change to the allowed sentence makes its words count again.
    expect(bannedIn(SCAN_NO_SIGNAL.replace("A scan", "The page"))).toEqual(["signal"]);
  });

  it("allow “Buy”, “Sell”, and “Hold” in the signal only inside its exact labels, with its own benchmark", () => {
    expect(signalBannedIn("Leans Buy vs. SPY · Moderate evidence. Leans Sell vs. SPY. Hold: no signal. An experimental signal.", "SPY")).toEqual([]);
    expect(signalBannedIn("Leans Buy vs. QQQ", "SPY")).toEqual(["Buy"]);
    expect(signalBannedIn("Buy now. Strong sell. Hold it. It should rise, guaranteed profit.", "SPY")).toEqual(["Buy", "sell", "Hold", "should", "guaranteed", "profit"]);
  });

  it("count sentences, words, and grade as intended", () => {
    expect(sentences("The p-value is 0.034. It held up! Did it? Yes…\nNext line")).toEqual(["The p-value is 0.034.", "It held up!", "Did it?", "Yes…", "Next line"]);
    expect(sentences("Leans Buy vs. SPY · Moderate evidence. Next.")).toEqual(["Leans Buy vs. SPY · Moderate evidence.", "Next."]);
    expect(longest("When the chance of “Fed maintains rate” rose, TLT tended to rise.").words).toBe(10);
    expect(gradeLevel("The cat sat on the mat. The dog ran.")).toBeLessThan(1);
    expect(gradeLevel("Heteroskedasticity-consistent covariance estimation necessitates considerable computational sophistication.")).toBeGreaterThan(20);
  });
});
