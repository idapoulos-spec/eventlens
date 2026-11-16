// The gauge draws exactly the r and range it's given, stops values past its scale at the edge with an
// arrow, and says in words what it draws: the headline's size word, "close to no link" exactly when the
// range reaches zero, and never more than the evidence badge does. Every wording path (scenarios.ts)
// is checked, with the gauge's own cases added on.

import { describe, expect, it } from "vitest";
import { fmtR } from "../research/parts";
import { formatCi } from "../research/stats";
import { angleOf, GAUGE_DIMS, GAUGE_SCALE, gaugeGeometry, pointAt, valueAt, type GaugeSize } from "./gauge";
import { analysisScenarios, ruleInput, scanScenarios } from "./scenarios";
import { bottomLine, gaugeLine, GAUGE_ENDS, reachesZero, type BottomLine, type DrawnGauge } from "./summary";
import { primaryWith, withParts } from "./test-helpers";

const SIZES: GaugeSize[] = ["full", "compact"];
const scenarios = [...analysisScenarios(), ...scanScenarios()];
const drawn = scenarios.filter((s): s is typeof s & { summary: BottomLine & { gauge: DrawnGauge } } => s.summary.gauge?.drawn === true);
/** Within rounding of the drawing to 0.01 units. */
const CLOSE = 1e-3;

describe("the gauge's geometry", () => {
  it("maps −0.5, 0, and +0.5 to the left end, the top, and the right end", () => {
    expect(angleOf(-GAUGE_SCALE)).toBeCloseTo(Math.PI, 12);
    expect(angleOf(0)).toBeCloseTo(Math.PI / 2, 12);
    expect(angleOf(GAUGE_SCALE)).toBeCloseTo(0, 12);
    expect(angleOf(0.25)).toBeCloseTo(Math.PI / 4, 12);
    for (const size of SIZES) {
      const d = GAUGE_DIMS[size];
      expect(pointAt(d, angleOf(-0.5), d.radius)).toEqual({ x: d.cx - d.radius, y: d.cy });
      expect(pointAt(d, angleOf(0), d.radius)).toEqual({ x: d.cx, y: d.cy - d.radius });
      expect(pointAt(d, angleOf(0.5), d.radius)).toEqual({ x: d.cx + d.radius, y: d.cy });
    }
  });

  it("puts the needle at exactly r and the band's ends at exactly the range", () => {
    for (const size of SIZES) {
      for (const [r, ci] of [
        [0.21, [0.05, 0.37]],
        [-0.04, [-0.13, 0.05]],
        [0, [-0.5, 0.5]],
        [0.499, [0.001, 0.4999]],
      ] as [number, [number, number]][]) {
        const g = gaugeGeometry(r, ci, size);
        expect(Math.abs(valueAt(size, g.needle.to) - r)).toBeLessThan(CLOSE);
        expect(g.needle.from).toEqual({ x: g.dims.cx, y: g.dims.cy });
        expect(Math.abs(valueAt(size, g.band!.from) - ci[0])).toBeLessThan(CLOSE);
        expect(Math.abs(valueAt(size, g.band!.to) - ci[1])).toBeLessThan(CLOSE);
        expect(g.band!.path.startsWith(`M${g.band!.from.x} ${g.band!.from.y}A`)).toBe(true);
        expect(g.band!.path.endsWith(` ${g.band!.to.x} ${g.band!.to.y}`)).toBe(true);
        expect(g.needle.past).toBeNull();
        expect(g.arrows).toEqual([]);
      }
    }
  });

  it("would notice a needle or a band end moved by 0.01 (a positive control for the checks above)", () => {
    const g = gaugeGeometry(0.21, [0.05, 0.37], "full");
    const moved = gaugeGeometry(0.22, [0.06, 0.37], "full");
    expect(Math.abs(valueAt("full", moved.needle.to) - 0.21)).toBeGreaterThan(CLOSE);
    expect(Math.abs(valueAt("full", moved.band!.from) - 0.05)).toBeGreaterThan(CLOSE);
    expect(moved.band!.path).not.toBe(g.band!.path);
  });

  it("stops r past the scale at its edge, flagged, with an arrow there", () => {
    for (const size of SIZES) {
      const high = gaugeGeometry(0.62, [0.31, 0.84], size);
      expect(high.needle.past).toBe("high");
      expect(valueAt(size, high.needle.to)).toBeCloseTo(GAUGE_SCALE, 6);
      expect(high.arrows.map((a) => a.edge)).toEqual(["high"]);
      const low = gaugeGeometry(-0.62, [-0.84, -0.31], size);
      expect(low.needle.past).toBe("low");
      expect(valueAt(size, low.needle.to)).toBeCloseTo(-GAUGE_SCALE, 6);
      expect(low.arrows.map((a) => a.edge)).toEqual(["low"]);
    }
  });

  it("cuts a range at the edge it runs past, marks each cut, and draws none of a range wholly past one", () => {
    for (const size of SIZES) {
      const one = gaugeGeometry(-0.2, [-0.8, 0.1], size);
      expect(one.bandPast).toEqual({ low: true, high: false, all: null });
      expect(valueAt(size, one.band!.from)).toBeCloseTo(-GAUGE_SCALE, 6);
      expect(Math.abs(valueAt(size, one.band!.to) - 0.1)).toBeLessThan(CLOSE);
      expect(one.arrows.map((a) => a.edge)).toEqual(["low"]);

      const both = gaugeGeometry(-0.04, [-0.71, 0.66], size);
      expect(both.bandPast).toEqual({ low: true, high: true, all: null });
      expect(both.arrows.map((a) => a.edge)).toEqual(["low", "high"]);

      const all = gaugeGeometry(0.7, [0.55, 0.9], size);
      expect(all.bandPast).toEqual({ low: false, high: true, all: "high" });
      expect(all.band).toBeNull();
      expect(all.arrows.map((a) => a.edge)).toEqual(["high"]);
    }
  });

  it("draws the needle alone without a range", () => {
    const g = gaugeGeometry(0.15, null, "full");
    expect(g.band).toBeNull();
    expect(g.bandPast).toBeNull();
    expect(g.arrows).toEqual([]);
    expect(Math.abs(valueAt("full", g.needle.to) - 0.15)).toBeLessThan(CLOSE);
  });

  it("marks −0.5, no link, and +0.5, and labels Opposite, No link, and Together inside the drawing", () => {
    for (const size of SIZES) {
      const g = gaugeGeometry(0.1, [0, 0.2], size);
      expect(g.ticks.map((t) => t.at)).toEqual([-0.5, 0, 0.5]);
      const zero = g.ticks[1];
      expect(zero.from.x).toBe(g.dims.cx);
      expect(zero.to.x).toBe(g.dims.cx);
      // The 0 tick reaches past the band on both sides, so it shows against the card.
      expect(zero.from.y - (g.dims.cy - g.dims.radius)).toBeGreaterThan(g.dims.band / 2);
      expect(g.dims.cy - g.dims.radius - zero.to.y).toBeGreaterThan(g.dims.band / 2);
      expect(g.labels.map((l) => l.text)).toEqual(["Opposite", "No link", "Together"]);
      for (const l of g.labels) {
        // About 0.6 em a letter, generous for these words.
        const w = 0.6 * g.dims.font * l.text.length;
        const left = l.anchor === "start" ? l.x : l.anchor === "end" ? l.x - w : l.x - w / 2;
        expect(left, `${size} ${l.text}`).toBeGreaterThanOrEqual(0);
        expect(left + w, `${size} ${l.text}`).toBeLessThanOrEqual(g.dims.width);
        expect(l.y - g.dims.font, `${size} ${l.text}`).toBeGreaterThanOrEqual(0);
        expect(l.y + 3, `${size} ${l.text}`).toBeLessThanOrEqual(g.dims.height);
      }
      // The needle stops short of the ring, so it never runs into the band.
      expect(g.dims.needle + g.dims.gap).toBeLessThan(g.dims.radius - g.dims.band / 2);
    }
  });
});

describe("the gauge's words", () => {
  it("covers every case: drawn with and without a range, past the scale, and not drawn", () => {
    expect(drawn.length).toBeGreaterThan(200);
    expect(drawn.some((s) => s.summary.gauge.ci === null)).toBe(true);
    expect(drawn.some((s) => s.summary.gauge.note.includes("An arrow marks the cut."))).toBe(true);
    expect(drawn.some((s) => s.summary.gauge.note.includes("Arrows mark the cuts."))).toBe(true);
    expect(scenarios.some((s) => s.summary.gauge?.drawn === false)).toBe(true);
    expect(scenarios.some((s) => s.summary.gauge === null)).toBe(true);
  });

  it("say “close to no link” exactly when the range reaches or crosses zero", () => {
    expect(reachesZero([0, 0.1])).toBe(true);
    expect(reachesZero([-0.1, 0])).toBe(true);
    expect(reachesZero([-0.1, 0.1])).toBe(true);
    expect(reachesZero([0.001, 0.1])).toBe(false);
    expect(reachesZero([-0.1, -0.001])).toBe(false);
    for (const { name, summary } of drawn) {
      const { ci, line } = summary.gauge;
      expect(line.includes("close to no link"), `${name}: ${line}`).toBe(ci !== null && reachesZero(ci));
    }
  });

  it("use the headline's size word and direction", () => {
    let compared = 0;
    for (const { name, summary } of drawn) {
      const said = /tended to (rise|fall) (slightly|somewhat|clearly)/.exec(summary.headline);
      if (!said) continue;
      const line = summary.gauge.line.toLowerCase();
      expect(line, name).toContain(said[2]);
      expect(line, name).toContain(said[1] === "rise" ? "together" : "opposite");
      compared++;
    }
    expect(compared).toBeGreaterThan(50);
  });

  it("use the headline's size word at the boundaries, where both round |r| to two decimals", () => {
    for (const r of [0.094, 0.0949, 0.095, 0.1, 0.101, 0.294, 0.295, 0.3, -0.0951, -0.2949, -0.3]) {
      const input = ruleInput("moderate");
      const primary = primaryWith(input.results.market!.primary!, { estimate: r, ci: r > 0 ? [r / 2, r * 1.5] : [r * 1.5, r / 2] });
      const s = bottomLine({ ...input, results: withParts(input.results, { primary }) });
      const word = /tended to (?:rise|fall) (slightly|somewhat|clearly)/.exec(s.headline)![1];
      expect(s.gauge?.drawn && s.gauge.line, String(r)).toBe(`Moved ${r > 0 ? "together" : "opposite"}, ${word}.`);
    }
  });

  it("read as written for each kind of case", () => {
    expect(gaugeLine(0.21, [0.05, 0.37], "found")).toBe("Moved together, somewhat.");
    expect(gaugeLine(-0.08, [-0.12, -0.03], "found")).toBe("Moved opposite, slightly.");
    expect(gaugeLine(0.35, [0.06, 0.55], "found")).toBe("Moved together, clearly.");
    expect(gaugeLine(-0.03, [-0.09, 0.04], "not_found")).toBe("Slightly opposite, close to no link.");
    expect(gaugeLine(0.15, [-0.02, 0.3], "not_found")).toBe("Somewhat together, but it could be close to no link.");
    expect(gaugeLine(0.34, [-0.04, 0.63], "not_found")).toBe("Clearly together, but it could be close to no link.");
    expect(gaugeLine(0.15, [0.02, 0.27], "uncorrected")).toBe("Moved together, somewhat, but not after correcting for testing many at once.");
    expect(gaugeLine(0.15, null, "found")).toBe("Moved together, somewhat.");
    expect(gaugeLine(-0.12, null, "not_found")).toBe("Somewhat opposite, with no range to judge it.");
    expect(gaugeLine(0, [-0.07, 0.07], "not_found")).toBe("No lean either way, close to no link.");
    expect(gaugeLine(0, null, "not_found")).toBe("No lean either way, with no range to judge it.");
  });

  it("never say more than the badge: no link where none was found, and never “no link” where one was", () => {
    const bare = /^Moved (together|opposite), (slightly|somewhat|clearly)\.$/;
    for (const { name, summary } of drawn) {
      const { line, ci } = summary.gauge;
      const scan = name.startsWith("scan ");
      switch (summary.level) {
        case "weak":
        case "moderate":
        case "strong":
          expect(line, name).toMatch(bare);
          expect(line, name).not.toContain("no link");
          break;
        case "no_clear_link":
        case "not_enough_data":
        case "nothing_stood_out":
          expect(line, name).not.toMatch(bare);
          if (ci && !reachesZero(ci)) expect(line, name).toContain(scan ? "not after correcting" : "no clear link");
          break;
      }
    }
  });

  it("note the scale, what Together means, and anything cut, missing, or uncorrected", () => {
    for (const { name, summary } of drawn) {
      const { r, ci, note } = summary.gauge;
      expect(note.startsWith(`Scale: r from ${GAUGE_ENDS[0]} to ${GAUGE_ENDS[1]}. “Together” means TLT rose when `), name).toBe(true);
      const past = Math.abs(r) > GAUGE_SCALE || (ci !== null && (ci[0] < -GAUGE_SCALE || ci[1] > GAUGE_SCALE));
      expect(/An arrow marks the cut\.|Arrows mark the cuts\./.test(note), name).toBe(past);
      expect(note.includes("so the needle stops at the edge"), name).toBe(Math.abs(r) > GAUGE_SCALE);
      expect(note.includes("only r is drawn"), name).toBe(ci === null);
      expect(note.includes("isn’t corrected for testing many at once"), name).toBe(name.startsWith("scan ") && ci !== null);
      expect(summary.derived, name).toEqual(expect.arrayContaining([...GAUGE_ENDS]));
    }
    const event = drawn.find((s) => s.name.startsWith("expected "))!;
    expect(event.summary.gauge.note).toContain("“Together” means TLT rose when the expected rate change rose.");
    const market = drawn.find((s) => s.name.startsWith("probability "))!;
    expect(market.summary.gauge.note).toContain("“Together” means TLT rose when the chance of “Fed maintains rate” rose.");
  });

  it("give a screen reader the direction, r, and the range, as the page prints them", () => {
    for (const { name, summary } of drawn) {
      const { r, ci, line, label } = summary.gauge;
      expect(label.startsWith(`How they moved together: ${line.charAt(0).toLowerCase()}${line.slice(1, -1)}. r = ${fmtR(r)}`), name).toBe(true);
      expect(label, name).toContain(ci ? `95% range ${formatCi(ci, fmtR)}` : "no 95% range");
      expect(label.endsWith(`on a scale from ${GAUGE_ENDS[0]} to ${GAUGE_ENDS[1]}.`), name).toBe(true);
    }
  });

  it("explain a missing gauge: no main test, or no correlation to draw; a scan with no lead has none", () => {
    for (const { name, summary } of scenarios) {
      const g = summary.gauge;
      if (name.startsWith("scan ")) {
        expect(g === null, name).toBe(summary.sections.every((s) => s.id !== "scan-lead"));
        continue;
      }
      if (summary.level === "none") expect(g, name).toEqual({ drawn: false, why: "No gauge: there’s no main test in this view." });
      else if (name.endsWith("gauge: no correlation")) expect(g, name).toEqual({ drawn: false, why: "No gauge: the main test has no correlation to draw in this window." });
      else expect(g?.drawn, name).toBe(true);
    }
  });
});
