// The card's markup at every wording path: what must hold for a reader on a keyboard or a screen
// reader, and for anyone who can't tell its colors apart. Rendered as the server renders it, from the
// same scenarios the wording tests use (scenarios.ts).

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { escapeHtml } from "@/lib/report/html";
import { textOf } from "../report/test-helpers";
import { BottomLineCard, ScanBottomLine } from "./BottomLineCard";
import { analysisScenarios, scanScenarios, signalScenarios } from "./scenarios";
import { DECIDED_LABEL, SIGNAL_DISCLAIMER, SIGNAL_RULES_TITLE, SIGNAL_TITLE } from "./signal";
import { ANALYSIS_LIMITS, LEVEL_LABEL, SCAN_NOT_ADVICE, type BottomLine } from "./summary";
import { plainText } from "./test-helpers";

const analyses = [...analysisScenarios(), ...signalScenarios()].map((s) => ({ name: s.name, summary: s.summary, html: renderToStaticMarkup(<BottomLineCard summary={s.summary} />) }));
const scans = scanScenarios().map((s) => ({ name: s.name, summary: s.summary, html: renderToStaticMarkup(<ScanBottomLine summary={s.summary} />) }));
const cards = [...analyses, ...scans];

const folds = (html: string) => [...html.matchAll(/<details\b[^>]*>([\s\S]*?)<\/details>/g)].map((m) => m[1]);
/** The fold whose title is `title`. */
const fold = (html: string, title: string) => folds(html).find((f) => plainText(/^<summary\b[^>]*>([\s\S]*?)<\/summary>/.exec(f)![1]) === title)!;
/** The signal panel: the group after the tiles. */
const panel = (html: string) => /<div role="group" aria-label="Experimental signal"[\s\S]*?<\/details><p[^>]*>[\s\S]*?<\/p><\/div>/.exec(html)?.[0];
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
  // An analysis's card folds the signal's rules first, in its panel above the reasons.
  const whyTitles = (s: BottomLine) => [...(s.signal ? [SIGNAL_RULES_TITLE] : []), ...(s.sections.length > 1 ? [s.why] : []), "What the terms mean"];

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
      const why = plainText(fold(html, summary.why));
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
      const look = /<span class="([^"]*rounded-full[^"]*)"/.exec(badge(html) ?? "")?.[1];
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

describe("the gauge", () => {
  const svgs = (html: string) => html.match(/<svg\b[^>]*>/g) ?? [];

  it("is one image to a screen reader, named with the direction, r, and the range", () => {
    for (const { name, html, summary } of cards) {
      const g = summary.gauge;
      if (g?.drawn) {
        expect(svgs(html), name).toHaveLength(1);
        expect(svgs(html)[0], name).toContain('role="img"');
        expect(svgs(html)[0], name).toContain(`aria-label="${escapeHtml(g.label)}"`);
        expect(g.label.length, name).toBeGreaterThan(40);
      } else expect(svgs(html), name).toEqual([]);
    }
  });

  it("is written out in the open: its line and note, or why there's none", () => {
    for (const { name, html, summary } of cards) {
      const g = summary.gauge;
      const open = plainText(withoutFolds(html));
      if (g?.drawn) {
        expect(open, name).toContain(g.line);
        expect(open, name).toContain(g.note);
      } else if (g) expect(open, name).toContain(g.why);
    }
  });

  it("sits under the answer, before the tiles, on an analysis's card; with the lead on a scan's", () => {
    for (const { name, html, summary } of analyses) {
      const g = summary.gauge!;
      const open = plainText(withoutFolds(html));
      const at = open.indexOf(g.drawn ? g.line : g.why);
      expect(at, name).toBeGreaterThan(open.indexOf(plainText(summary.headline)));
      expect(at, name).toBeLessThan(open.indexOf(summary.tiles[0].label));
    }
    for (const { name, html, summary } of scans) {
      if (!summary.gauge?.drawn) continue;
      const open = plainText(withoutFolds(html));
      const lead = summary.sections.find((s) => s.id === "scan-lead")!;
      expect(open.indexOf(summary.gauge.line), name).toBeGreaterThan(open.indexOf(plainText(lead.items[0])));
      expect(open.indexOf(summary.gauge.note), name).toBeLessThan(open.indexOf(lead.items[1]));
    }
  });

  it("is drawn in the correlation teal, grays, and text colors: never Kalshi's, the stock's, or a direction's", () => {
    let drawn = 0;
    for (const { name, html } of cards) {
      const svg = /<svg\b[\s\S]*?<\/svg>/.exec(html)?.[0];
      if (!svg) continue;
      drawn++;
      const colors = new Set([...svg.matchAll(/(?:stroke|fill)="([^"]+)"/g)].map((m) => m[1]));
      expect([...colors].sort(), name).toEqual(
        expect.arrayContaining(["none", "var(--axis)", "var(--ink-secondary)", "var(--series-correlation)"]),
      );
      for (const c of colors) expect(["none", "var(--axis)", "var(--ink-secondary)", "var(--series-correlation)", "var(--surface)", "var(--surface-raised)"], `${name}: ${c}`).toContain(c);
    }
    expect(drawn).toBeGreaterThan(200);
  });
});

describe("the experimental signal", () => {
  it("is on every analysis's card, under the tiles and before the folds, and never on a scan's", () => {
    for (const { name, html, summary } of analyses) {
      const p = panel(html);
      expect(p, name).toBeDefined();
      expect(summary.signal, name).not.toBeNull();
      // After the tiles' list closes, and before the folds' block opens.
      expect(html.indexOf(p!), name).toBeGreaterThan(html.indexOf("</dl>"));
      expect(html.indexOf(p!) + p!.length, name).toBeLessThanOrEqual(html.indexOf('<div class="mt-4 grid gap-1 border-t'));
    }
    for (const { name, html } of scans) expect(html, name).not.toContain(SIGNAL_TITLE);
  });

  it("writes the label and its level out in a live region, and shows the reason, the chips, and how it's decided in the open", () => {
    for (const { name, html, summary } of analyses) {
      const s = summary.signal!;
      const p = panel(html)!;
      const live = [...p.matchAll(/<p role="status"[^>]*>([\s\S]*?)<\/p>/g)].map((m) => plainText(m[1]));
      expect(live, name).toEqual([s.levelText ? `${s.text} · ${s.levelText}` : s.text]);
      const open = plainText(withoutFolds(p));
      for (const c of s.chips) expect(open, `${name}: ${c.label}`).toContain(`${c.label}: ${c.value}`);
      expect(p.match(/<li class="min-w-0 rounded-full/g), name).toHaveLength(4);
      expect(open, name).toContain(plainText(s.reason));
      expect(open, name).toContain(`${DECIDED_LABEL} ${s.decided}`);
      expect(plainText(fold(p, SIGNAL_RULES_TITLE)), name).toContain(s.rules[0]);
    }
  });

  it("styles its level with the badge's ink ramp, and a lean apart from a hold by size and weight, not hue", () => {
    for (const { name, html, summary } of analyses) {
      const s = summary.signal!;
      const p = panel(html)!;
      const label = /<p role="status"[^>]*><span class="([^"]*)"/.exec(p)![1];
      expect(label, name).toContain(s.label === "buy" || s.label === "sell" ? "text-xl text-ink" : "text-lg text-ink-secondary");
      if (s.levelText) expect(p, name).toMatch(/rounded-full px-2\.5 py-0\.5 text-xs font-semibold/);
    }
  });
});

describe("the disclaimer", () => {
  it("appears exactly once, word for word, always in the open: the signal's on an analysis, the scan's own on a scan", () => {
    for (const { name, html } of analyses) {
      expect(plainText(html).split(SIGNAL_DISCLAIMER).length - 1, name).toBe(1);
      expect(plainText(withoutFolds(html)).split(SIGNAL_DISCLAIMER).length - 1, name).toBe(1);
    }
    for (const { name, html } of scans) {
      expect(plainText(html).split(SCAN_NOT_ADVICE).length - 1, name).toBe(1);
      expect(plainText(withoutFolds(html)).split(SCAN_NOT_ADVICE).length - 1, name).toBe(1);
    }
  });

  it("ends the signal panel; the limits are the card's last line, with no marker inside them", () => {
    for (const { name, html } of analyses) {
      expect(panel(html)!.endsWith(`${SIGNAL_DISCLAIMER}</p></div>`), name).toBe(true);
    }
    for (const { name, html } of cards) {
      const last = /<p class="[^"]*">((?:(?!<p\b)[\s\S])*?)<\/p><\/section>$/.exec(html)?.[1] ?? "";
      expect(last, name).toContain(analyses.some((a) => a.html === html) ? ANALYSIS_LIMITS : SCAN_NOT_ADVICE);
      expect(last, name).not.toContain("data-term");
    }
  });
});
