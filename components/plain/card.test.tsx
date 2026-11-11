// The card's markup at every wording path: what must hold for a reader on a keyboard or a screen
// reader, and for anyone who can't tell its colors apart. Rendered as the server renders it, from the
// same scenarios the wording tests use (scenarios.ts).

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { textOf } from "../report/test-helpers";
import { BottomLineCard, ScanBottomLine } from "./BottomLineCard";
import { analysisScenarios, scanScenarios } from "./scenarios";
import { LEVEL_LABEL, NOT_ADVICE, type BottomLine } from "./summary";
import { plainText } from "./test-helpers";

const analyses = analysisScenarios().map((s) => ({ name: s.name, summary: s.summary, html: renderToStaticMarkup(<BottomLineCard summary={s.summary} />) }));
const scans = scanScenarios().map((s) => ({ name: s.name, summary: s.summary, html: renderToStaticMarkup(<ScanBottomLine summary={s.summary} />) }));
const cards = [...analyses, ...scans];

const folds = (html: string) => [...html.matchAll(/<details\b[^>]*>([\s\S]*?)<\/details>/g)].map((m) => m[1]);
const withoutFolds = (html: string) => html.replace(/<details\b[\s\S]*?<\/details>/g, "");
/** The badge: the live region that holds the rating (a term's definition has its own, without a class). */
const badge = (html: string) => /<p role="status"[^>]*>([\s\S]*?)<\/p>/.exec(html)?.[1];

describe("the card's markup", () => {
  it("covers every level", () => {
    const levels = new Set(cards.map((c) => c.summary.level));
    for (const level of Object.keys(LEVEL_LABEL)) expect(levels).toContain(level);
  });

  it("stays in one element the pins can strip: no <section> inside it", () => {
    for (const { name, html } of cards) {
      expect(html.startsWith("<section data-plain-english=\"\""), name).toBe(true);
      expect(html.match(/<section\b/g), name).toHaveLength(1);
      expect(html.indexOf("</section>"), name).toBe(html.length - "</section>".length);
    }
  });

  it("is titled The bottom line, for the eye and for a screen reader", () => {
    for (const { name, html } of cards) {
      expect(html, name).toContain('aria-label="The bottom line"');
      expect(textOf(html).startsWith("The bottom line"), name).toBe(true);
    }
  });

  it("shows the question, the verdict, and the finding in the open, in that order", () => {
    for (const { name, html, summary } of cards) {
      const open = plainText(withoutFolds(html));
      const question = open.indexOf(plainText(summary.question));
      const answer = open.indexOf(plainText(`${summary.verdict} ${summary.headline}`));
      expect(question, name).toBeGreaterThanOrEqual(0);
      expect(answer, name).toBeGreaterThan(question);
    }
  });

  it("shows every tile in the open: its label, its answer, and its note", () => {
    for (const { name, html, summary } of cards) {
      const open = plainText(withoutFolds(html));
      for (const t of summary.tiles) {
        expect(open, `${name}: ${t.label}`).toContain(plainText(t.label));
        expect(open, `${name}: ${t.value}`).toContain(plainText(t.value));
        expect(open, `${name}: ${t.note}`).toContain(plainText(t.note));
      }
    }
  });

  it("reads each tile as a label and its values, for a screen reader", () => {
    for (const { name, html, summary } of cards) {
      expect(html.match(/<dt class="text-xs/g)?.length ?? 0, name).toBe(summary.tiles.length);
      for (const t of summary.tiles) expect(html, name).toContain(`>${t.label}</dt>`);
    }
  });
});

describe("the collapsible parts", () => {
  const whyTitles = (s: BottomLine) => (s.sections.length > 1 ? [s.why, "What the terms mean"] : ["What the terms mean"]);

  it("are native details and summary: reachable with Tab, opened with Enter or Space, announced as they change", () => {
    for (const { name, html, summary } of cards) {
      const parts = folds(html);
      expect(parts, name).toHaveLength(whyTitles(summary).length);
      expect(parts.map((p) => plainText(/^<summary\b[^>]*>([\s\S]*?)<\/summary>/.exec(p)![1])), name).toEqual(whyTitles(summary));
      expect(html, name).not.toMatch(/tabindex|<details\b[^>]*\bopen\b|onClick/i);
    }
  });

  it("hold no other control in a summary, so its keys open it and nothing else", () => {
    for (const { name, html } of cards) {
      for (const [inner] of html.matchAll(/<summary\b[^>]*>[\s\S]*?<\/summary>/g)) expect(inner, name).not.toMatch(/data-term|<button/);
    }
  });

  it("hold the reasons, the caveats, and how the rating works, each in its place", () => {
    for (const { name, html, summary } of analyses) {
      const why = plainText(folds(html)[0]);
      for (const s of summary.sections.filter((x) => x.id !== "limits")) {
        for (const item of s.items) expect(why, `${name}: ${item}`).toContain(plainText(item));
      }
      expect(why, name).toContain("How the rating works");
    }
    for (const { name, html, summary } of scans.filter((c) => c.summary.sections.length > 1)) {
      const why = plainText(folds(html)[0]);
      for (const item of summary.sections.find((x) => x.id === "scan-why")!.items) expect(why, `${name}: ${item}`).toContain(plainText(item));
      expect(why, name).not.toContain("How the rating works");
    }
  });

  it("are big enough to tap", () => {
    for (const { name, html } of cards) {
      for (const [tag] of html.matchAll(/<summary\b[^>]*>/g)) expect(tag, name).toMatch(/py-1 text-sm/);
    }
  });
});

describe("the evidence badge", () => {
  it("writes the level out, with its meaning for a screen reader, or isn't there at all", () => {
    for (const { name, html, summary } of analyses) {
      if (summary.level === "none") expect(badge(html), name).toBe("");
      else expect(plainText(badge(html)!), name).toBe(`Evidence: ${LEVEL_LABEL[summary.level]}`);
    }
    for (const { name, html, summary } of scans) {
      if (summary.sections.some((s) => s.id === "scan-lead")) expect(plainText(badge(html)!), name).toBe(`Evidence: ${LEVEL_LABEL[summary.level]}`);
      else expect(badge(html), name).toBeUndefined();
    }
  });

  it("never leans on a color that reads as a direction, or a series", () => {
    for (const { name, html } of cards) {
      for (const color of ["bg-up", "bg-down", "bg-warn", "text-up", "text-down", "text-warn", "border-warn", "bg-series-kalshi", "bg-series-stock", "text-series-"]) {
        expect(html.includes(color), `${name}: ${color}`).toBe(false);
      }
    }
  });

  it("looks different at each level, beyond its words", () => {
    const looks = new Map<string, string>();
    for (const { html, summary } of analyses) {
      const look = /<span class="([^"]*rounded-full[^"]*)"/.exec(html)?.[1];
      if (look) looks.set(summary.level, look);
    }
    expect([...looks.keys()].sort()).toEqual(["moderate", "no_clear_link", "not_enough_data", "pending", "strong", "weak"]);
    expect(new Set(looks.values()).size).toBe(6);
  });

  it("is what a screen reader hears: the meter beside the written level is hidden from it", () => {
    for (const { name, html, summary } of analyses) {
      if (summary.level === "none") expect(html, name).not.toContain('aria-hidden="true"');
      else expect(html.match(/<div aria-hidden="true"/g), name).toHaveLength(1);
    }
    for (const { name, html } of scans) expect(html, name).not.toContain('aria-hidden="true"');
  });
});

describe("the disclaimer", () => {
  it("appears exactly once, word for word, always in the open", () => {
    for (const { name, html } of cards) {
      expect(plainText(html).split(NOT_ADVICE).length - 1, name).toBe(1);
      expect(plainText(withoutFolds(html)).split(NOT_ADVICE).length - 1, name).toBe(1);
    }
  });

  it("is the card's last line, with no marker inside it", () => {
    for (const { name, html } of cards) {
      const last = /<p class="[^"]*">((?:(?!<p\b)[\s\S])*?)<\/p><\/section>$/.exec(html)?.[1] ?? "";
      expect(last, name).toContain(NOT_ADVICE);
      expect(last, name).not.toContain("data-term");
    }
  });
});
