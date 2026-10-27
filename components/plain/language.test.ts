import { describe, expect, it } from "vitest";
import { GLOSSARY } from "./glossary";
import { analysisScenarios, scanScenarios } from "./scenarios";
import { NOT_ADVICE, RATING_METHOD } from "./summary";
import { bannedIn, gradeLevel, longest, sentences, summaryText } from "./test-helpers";

// The plain-English summary never uses trading language, and stays short and simple: no sentence
// over 25 words, and a Flesch–Kincaid grade of at most 9 (numbers, tickers, and quoted Kalshi labels
// count as one plain word each). Every wording path is checked (scenarios.ts): each rating rule for a
// market and an event at six settings, a scan in every state, the glossary, and how the rating works.

const MAX_WORDS = 25;
const MAX_GRADE = 9;
const scenarios = [...analysisScenarios(), ...scanScenarios()];

describe("the plain-English summary's language", () => {
  it("covers every wording path", () => {
    expect(scenarios.length).toBeGreaterThan(200);
    const levels = new Set(scenarios.map((s) => s.summary.level));
    for (const level of ["not_enough_data", "no_clear_link", "nothing_stood_out", "weak", "moderate", "strong", "pending", "none"]) expect(levels).toContain(level);
  });

  it("never uses trading language, outside the one sentence that says it isn't advice", () => {
    for (const s of scenarios) expect(bannedIn(summaryText(s.summary)), s.name).toEqual([]);
    for (const e of GLOSSARY) expect(bannedIn(`${e.term} ${e.definition}`), e.id).toEqual([]);
    expect(bannedIn(RATING_METHOD.join(" "))).toEqual([]);
  });

  it("says once, word for word, that it isn't a prediction, a cause, or a recommendation", () => {
    for (const s of scenarios) expect(summaryText(s.summary).split(NOT_ADVICE).length - 1, s.name).toBe(1);
  });

  it(`keeps every sentence to ${MAX_WORDS} words and every card at grade ${MAX_GRADE} or below`, () => {
    for (const s of scenarios) {
      const text = summaryText(s.summary);
      expect(longest(text).words, `${s.name}: ${longest(text).sentence}`).toBeLessThanOrEqual(MAX_WORDS);
      expect(gradeLevel(text), s.name).toBeLessThanOrEqual(MAX_GRADE);
    }
    for (const text of [...GLOSSARY.map((e) => e.definition), RATING_METHOD.join(" ")]) {
      expect(longest(text).words, longest(text).sentence).toBeLessThanOrEqual(MAX_WORDS);
      expect(gradeLevel(text), text).toBeLessThanOrEqual(MAX_GRADE);
    }
  });
});

describe("the language checks themselves", () => {
  it("catch every banned word and its forms, in any case, as whole words", () => {
    const caught = bannedIn("Buy now. Buying, sells, SELLING. A signal; signals. Opportunity, opportunities. We recommend; a recommendation. Profit, profitable. You should  invest.");
    expect(caught.map((w) => w.toLowerCase().replace(/\s+/g, " "))).toEqual([
      "buy",
      "buying",
      "sells",
      "selling",
      "signal",
      "signals",
      "opportunity",
      "opportunities",
      "recommend",
      "recommendation",
      "profit",
      "profitable",
      "should invest",
    ]);
  });

  it("leave alone words that only contain them, and remove exactly the one allowed sentence", () => {
    expect(bannedIn("A weak sign, a buyer’s guide, a seller, signed, investment, trading days.")).toEqual([]);
    expect(bannedIn(`${NOT_ADVICE} Other news.`)).toEqual([]);
    // Any change to the allowed sentence makes its words count again.
    expect(bannedIn(NOT_ADVICE.replace("anything", "now"))).toEqual(["recommendation", "buy", "sell"]);
  });

  it("count sentences, words, and grade as intended", () => {
    expect(sentences("The p-value is 0.034. It held up! Did it? Yes…\nNext line")).toEqual(["The p-value is 0.034.", "It held up!", "Did it?", "Yes…", "Next line"]);
    expect(longest("When the chance of “Fed maintains rate” rose, TLT tended to rise.").words).toBe(10);
    expect(gradeLevel("The cat sat on the mat. The dog ran.")).toBeLessThan(1);
    expect(gradeLevel("Heteroskedasticity-consistent covariance estimation necessitates considerable computational sophistication.")).toBeGreaterThan(20);
  });
});
