// The gauge's colors and their contrast (WCAG 2), from the app's tokens as app/globals.css defines them
// and the report's light palette: the needle, the band, and the arrows are the correlation teal; the
// track is the axis gray; the ticks and labels are text colors. Drawn marks need 3:1 against what they
// touch, text 4.5:1 (and the card's own text keeps the 9.2:1 the README states). The figures the README
// quotes are pinned here, so a changed token fails until they're updated together.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { GRID, INK, SURFACE } from "@/lib/report/charts";
import { REPORT_GAUGE_PALETTE, REPORT_TEAL } from "../report/bottomLineReport";
import { GAUGE_DIMS } from "./gauge";
import { gaugeSvg } from "./gaugeSvg";
import type { DrawnGauge } from "./summary";

const css = readFileSync(join(process.cwd(), "app/globals.css"), "utf8");
const token = (name: string) => {
  const m = new RegExp(`--${name}:\\s*(#[0-9a-f]{6});`, "i").exec(css);
  if (!m) throw new Error(`no --${name} in globals.css`);
  return m[1].toLowerCase();
};

/** WCAG 2 relative luminance of a #rrggbb color. */
function luminance(hex: string): number {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((v) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** WCAG 2 contrast ratio, to two decimals. */
function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return Number(((hi + 0.05) / (lo + 0.05)).toFixed(2));
}

const GRAPHIC = 3;
const TEXT = 4.5;
/** What the README says of every text in the card. */
const CARD_TEXT = 9.2;

describe("the gauge's colors on the page", () => {
  const teal = token("series-correlation");
  const track = token("axis");
  const label = token("ink-secondary");
  const ink = token("ink");
  const cards = { analysis: token("surface"), scan: token("surface-raised") };

  it("are the correlation teal, not Kalshi's blue or the stock's orange", () => {
    expect(teal).toBe("#199e70");
    expect(teal).not.toBe(token("series-kalshi"));
    expect(teal).not.toBe(token("series-stock"));
  });

  it("set the needle, the band, and the arrows apart from the card and the track", () => {
    expect([contrast(teal, cards.analysis), contrast(teal, cards.scan)]).toEqual([5.32, 4.85]);
    expect(contrast(teal, track)).toBe(3.45);
    for (const v of [contrast(teal, cards.analysis), contrast(teal, cards.scan), contrast(teal, track)]) expect(v).toBeGreaterThanOrEqual(GRAPHIC);
  });

  it("keep the labels, ticks, line, and note readable on both cards", () => {
    expect([contrast(label, cards.analysis), contrast(label, cards.scan)]).toEqual([10.11, 9.21]);
    for (const bg of Object.values(cards)) {
      expect(contrast(label, bg)).toBeGreaterThanOrEqual(CARD_TEXT);
      expect(contrast(ink, bg)).toBeGreaterThanOrEqual(CARD_TEXT);
    }
  });

  it("leave the track recessive: it's decoration, the ticks and labels carry the scale", () => {
    expect([contrast(track, cards.analysis), contrast(track, cards.scan)]).toEqual([1.54, 1.4]);
  });
});

describe("the gauge's colors in a report", () => {
  const gauge: DrawnGauge = { drawn: true, r: 0.21, ci: [0.05, 0.37], line: "Moved together, somewhat.", note: "", label: "How they moved together" };

  it("are the app's teal, on the report's light surface", () => {
    expect(REPORT_TEAL).toBe(token("series-correlation"));
    expect(REPORT_GAUGE_PALETTE).toEqual({ teal: REPORT_TEAL, track: GRID, ink: INK, surface: SURFACE });
  });

  it("set the band apart from the card, and its gap from the track, which the teal alone can't", () => {
    expect(contrast(REPORT_TEAL, SURFACE)).toBe(3.32);
    expect(contrast(REPORT_TEAL, SURFACE)).toBeGreaterThanOrEqual(GRAPHIC);
    // Teal on the report's gray is under 3:1, so the band never touches it: a gap of the surface at each end.
    expect(contrast(REPORT_TEAL, GRID)).toBe(2.57);
    const svg = gaugeSvg(gauge, "full", REPORT_GAUGE_PALETTE);
    const d = GAUGE_DIMS.full;
    expect(svg).toMatch(new RegExp(`<path d="[^"]+" fill="none" stroke="${SURFACE}" stroke-width="${d.band}"/><path d="[^"]+" fill="none" stroke="${REPORT_TEAL}" stroke-width="${d.band}" data-part="band"/>`));
    // And the band is wider than the track, so along its length it meets only the surface.
    expect(d.band).toBeGreaterThan(d.track);
    expect(d.gap).toBeGreaterThanOrEqual(2);
  });

  it("keep the labels readable", () => {
    expect(contrast(INK, SURFACE)).toBe(7.73);
    expect(contrast(INK, SURFACE)).toBeGreaterThanOrEqual(TEXT);
    // The written line is the figure's caption in the printable page (#5b6470 on white).
    expect(contrast("#5b6470", "#ffffff")).toBeGreaterThanOrEqual(TEXT);
  });
});
