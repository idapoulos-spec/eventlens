// How a glossary term's definition opens and closes, as a pure reducer (tests run without a DOM),
// how its popover stays inside a narrow viewport, and where a card's text marks terms.

import { createElement, Fragment, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { GLOSSARY, type GlossaryEntry } from "./glossary";
import { analysisScenarios, scanScenarios } from "./scenarios";
import { markTerms, popoverShift, TERM_CLOSED, termReducer, type TermAction, type TermState } from "./Term";

const html = (node: ReactNode) => renderToStaticMarkup(createElement(Fragment, null, node));
/** The terms marked in a rendered text, in order. */
const marked = (node: ReactNode) => [...html(node).matchAll(/<button[^>]*>([^<]*)<\/button>/g)].map((m) => m[1]);

const run = (actions: TermAction[], from: TermState = TERM_CLOSED) => actions.reduce(termReducer, from);

describe("a term's definition", () => {
  it("shows on hover and hides when the pointer leaves (desktop)", () => {
    expect(run(["hover"])).toEqual({ open: true, pinned: false });
    expect(run(["hover", "unhover"])).toEqual(TERM_CLOSED);
  });

  it("shows on keyboard focus and hides on blur or Escape", () => {
    expect(run(["focus"]).open).toBe(true);
    expect(run(["focus", "blur"])).toEqual(TERM_CLOSED);
    expect(run(["focus", "escape"])).toEqual(TERM_CLOSED);
  });

  it("toggles on a tap, which focuses the button and then presses it (phone)", () => {
    expect(run(["focus", "press"])).toEqual({ open: true, pinned: true });
    expect(run(["focus", "press", "press"])).toEqual(TERM_CLOSED);
    // Where a tap doesn't focus the button (iOS Safari), the press alone opens it.
    expect(run(["press"])).toEqual({ open: true, pinned: true });
    expect(run(["press", "press"])).toEqual(TERM_CLOSED);
  });

  it("stays open after a click when the pointer leaves, until a tap elsewhere or Escape", () => {
    const clicked = run(["hover", "focus", "press", "unhover"]);
    expect(clicked).toEqual({ open: true, pinned: true });
    expect(run(["outside"], clicked)).toEqual(TERM_CLOSED);
    expect(run(["escape"], clicked)).toEqual(TERM_CLOSED);
  });

  it("closes from any state on Escape, blur, or a tap elsewhere", () => {
    const states: TermState[] = [TERM_CLOSED, { open: true, pinned: false }, { open: true, pinned: true }];
    for (const s of states) for (const a of ["escape", "blur", "outside"] as const) expect(termReducer(s, a)).toEqual(TERM_CLOSED);
  });

  it("doesn't unpin when hovered or focused again", () => {
    const pinned = { open: true, pinned: true };
    expect(termReducer(pinned, "hover")).toBe(pinned);
    expect(termReducer(pinned, "focus")).toBe(pinned);
  });
});

describe("a term's popover", () => {
  it("stays put when it fits", () => {
    expect(popoverShift(16, 200, 320)).toBe(0);
  });

  it("moves left so its right edge stays 8 px inside a 320 px viewport", () => {
    // A 288 px popover (18rem) under a term at x = 200 would end at 488.
    const shift = popoverShift(200, 288, 320);
    expect(200 - shift + 288).toBe(312);
  });

  it("never moves past the left gutter, even when it's wider than the room", () => {
    expect(popoverShift(100, 400, 320)).toBe(92);
  });
});

describe("a card's marked terms", () => {
  it("marks the first use of each term in the card, not later ones", () => {
    const [a, b] = markTerms(["The main test’s p-value is 0.034.", "Its p-value and its correlation r = +0.07."]);
    expect(marked(a)).toEqual(["p-value"]);
    expect(marked(b)).toEqual(["correlation"]);
  });

  it("keeps the text exactly as written around the marks", () => {
    const text = "Main test: correlation r = +0.07 (95% range +0.01 to +0.18), p-value 0.034.";
    const [node] = markTerms([text]);
    expect(marked(node)).toEqual(["correlation", "95% range", "p-value"]);
    expect(html(node).replace(/<[^>]+>/g, "")).toBe(text);
  });

  it("marks only whole words", () => {
    const [node] = markTerms(["Two correlations, then one correlation."]);
    expect(marked(node)).toEqual(["correlation"]);
    expect(html(node)).toMatch(/^Two correlations, then one <span data-term/);
  });

  it("leaves a mark that overlaps an earlier one in the same text for a later text", () => {
    const entries: GlossaryEntry[] = [
      { id: "beta", term: "A", definition: "", phrases: ["held fixed"] },
      { id: "bootstrap", term: "B", definition: "", phrases: ["fixed rules"] },
    ];
    const [first, second] = markTerms(["Moves held fixed rules here.", "Some fixed rules."], entries);
    expect(marked(first)).toEqual(["held fixed"]);
    expect(marked(second)).toEqual(["fixed rules"]);
  });

  it("returns a text with no terms as it is", () => {
    expect(markTerms(["Nothing to mark here."])).toEqual(["Nothing to mark here."]);
  });

  it("renders a closed marker as the button and an empty live region, which the page pins read back as the term", () => {
    const [node] = markTerms(["A fragile result."]);
    expect(html(node)).toMatch(
      /^A <span data-term="" class="[^"]*"><button type="button" aria-expanded="false" class="[^"]*">fragile<\/button><span role="status"><\/span><\/span> result\.$/,
    );
  });

  it("marks every term that has phrases somewhere in the cards' wording", () => {
    const texts = [...analysisScenarios(), ...scanScenarios()].map(({ summary }) => [summary.headline, ...summary.sections.flatMap((x) => x.items)].join(" "));
    const found = new Set(texts.flatMap((t) => marked(markTerms([t])[0])));
    for (const e of GLOSSARY.filter((x) => x.phrases.length > 0)) expect(e.phrases.some((p) => found.has(p)), e.id).toBe(true);
  });
});
