import { describe, expect, it } from "vitest";
import { computeChanges } from "./changes";
import { RESEARCH_CSV_COLUMNS, researchCsv, researchCsvColumns } from "./csv";
import { eventStudy } from "./event-study";
import { marketAdjustment } from "./market-model";
import { buildExpectedRows, type ExpectedPoint } from "./research";
import { simulateMarketRows } from "./test-helpers";
import { expectedVariable, probabilityVariable } from "./variable";

// Research on an event's expected value: rows read E at their own mark, changes are in E's unit,
// and an interval whose open outcomes changed has no change.

const HOUR = 60 * 60 * 1000;
// Mon, Sep 28, 2026, 10:00 AM New York (EDT).
const T = Date.parse("2026-09-28T14:00:00Z");
const at = (h: number) => T + h * HOUR;
const BP = expectedVariable({ unit: "bp", label: "the expected rate change" });
const SET = ["E-C25", "E-H0", "E-H25"];

const mark = (h: number, value: number | null, over: Partial<ExpectedPoint> = {}): ExpectedPoint => ({
  t: at(h),
  value,
  sumP: value === null ? null : 1,
  openSet: SET,
  missing: value === null ? "stale_quote" : null,
  ...over,
});

const stock = (...hours: number[]) => hours.map((h) => ({ t: at(h), value: 100 + h }));

describe("buildExpectedRows", () => {
  it("reads E at each row's own mark, never an older one", () => {
    const rows = buildExpectedRows({
      stock: stock(0, 1, 2, 3),
      marks: [mark(0, -3), mark(1, null), mark(3, -4)],
      resolution: "hourly",
    });
    expect(rows.map((r) => [r.kalshiValue, r.exclusion, r.kalshiAsOf])).toEqual([
      [-3, null, at(0)],
      [null, "expected_missing", at(1)],
      // No mark at all at 12:00.
      [null, "before_kalshi", null],
      [-4, null, at(3)],
    ]);
    expect(rows[1].expected).toEqual({ sumP: null, openSet: SET.join(" "), missing: "stale_quote" });
    expect(rows[0].kalshiSource).toBeNull();
  });
});

describe("computeChanges on expected values", () => {
  it("measures ΔE in the variable's unit (scale 1)", () => {
    const rows = buildExpectedRows({ stock: stock(0, 1, 2), marks: [mark(0, -3), mark(1, -3.5), mark(2, -3.5)], resolution: "hourly" });
    const { changes } = computeChanges(rows, BP.scale);
    expect(changes.map((c) => c.kalshiChange)).toEqual([-0.5, 0]);
  });

  it("leaves out an interval whose open outcomes changed, with no change", () => {
    const rows = buildExpectedRows({
      stock: stock(0, 1, 2),
      marks: [mark(0, -3), mark(1, -2, { openSet: ["E-H0", "E-H25"] }), mark(2, -2.5, { openSet: ["E-H0", "E-H25"] })],
      resolution: "hourly",
    });
    const { intervals, changes, excluded } = computeChanges(rows, BP.scale);
    expect(intervals[1]).toMatchObject({ kalshiChange: null, exclusion: "outcome_set_changed" });
    expect(changes.map((c) => c.kalshiChange)).toEqual([-0.5]);
    expect(excluded).toEqual({ outcome_set_changed: 1 });
  });

  it("leaves out intervals with a missing E at either end", () => {
    const rows = buildExpectedRows({ stock: stock(0, 1, 2), marks: [mark(0, -3), mark(1, null), mark(2, -3)], resolution: "hourly" });
    expect(computeChanges(rows, BP.scale).excluded).toEqual({ expected_missing: 2 });
  });

  it("finds jumps at bp thresholds", () => {
    const rows = buildExpectedRows({
      stock: stock(0, 1, 2, 3, 4, 5, 6),
      marks: [0, 1, 2, 3, 4, 5, 6].map((h) => mark(h, h === 3 ? -2.7 : h > 3 ? -2.7 : -3)),
      resolution: "hourly",
    });
    const series = computeChanges(rows, BP.scale);
    const study = eventStudy(rows, series.changes, { threshold: 0.25, before: 1, after: 1 });
    expect(study.rises.events).toEqual([{ t: at(3), kalshiChange: expect.closeTo(0.3, 12) }]);
    expect(eventStudy(rows, series.changes, { threshold: 0.5, before: 1, after: 1 }).detected).toBe(0);
  });
});

describe("marketAdjustment on expected values", () => {
  it("finds the event study's jumps in the variable's unit, so its beta leaves out the same windows", () => {
    const { rows, closesByT } = simulateMarketRows({ sessions: 30, resolution: "hourly", seed: 5 });
    // The same path, held in its change unit already, as an expected value in bp is.
    const bp = rows.map((r) => ({ ...r, kalshiValue: r.kalshiValue! * 100 }));
    const event = { threshold: 1.5, before: 4, after: 4 };
    const asProbability = marketAdjustment({ full: rows, rows, changes: computeChanges(rows, 100).changes, scale: 100, closesByT, event, resolution: "hourly" });
    const asExpected = marketAdjustment({ full: bp, rows: bp, changes: computeChanges(bp, BP.scale).changes, scale: BP.scale, closesByT, event, resolution: "hourly" });
    expect(asProbability.eventModel).not.toBeNull();
    expect(asExpected.eventModel?.n).toBe(asProbability.eventModel?.n);
    expect(asExpected.studies.abnormal?.detected).toBe(asProbability.studies.abnormal?.detected);
  });
});

describe("researchCsv for an expected value", () => {
  const rows = buildExpectedRows({
    stock: stock(0, 1, 2),
    marks: [mark(0, -3), mark(1, -2.75), mark(2, null, { missing: "coverage", openSet: [] })],
    resolution: "hourly",
  });
  const lines = researchCsv(rows, "hourly", null, BP).split("\r\n");
  const columns = researchCsvColumns(BP);
  const cells = (line: string) => Object.fromEntries(line.split(",").map((v, i) => [columns[i], v]));

  it("names the value and change columns in bp and appends Σp and the open outcomes", () => {
    expect(lines[0]).toBe(columns.join(","));
    expect(columns).toHaveLength(RESEARCH_CSV_COLUMNS.length + 2);
    expect(columns.slice(0, RESEARCH_CSV_COLUMNS.length).filter((c, i) => c !== RESEARCH_CSV_COLUMNS[i])).toEqual([
      "kalshi_expected_bp",
      "expected_change_bp",
    ]);
    expect(columns.slice(-2)).toEqual(["sum_p", "open_outcomes"]);
  });

  it("writes E, ΔE in bp, and the reason E is missing", () => {
    expect(cells(lines[1])).toMatchObject({ kalshi_expected_bp: "-3", kalshi_source: "", sum_p: "1", open_outcomes: "E-C25 E-H0 E-H25" });
    expect(cells(lines[2])).toMatchObject({ kalshi_expected_bp: "-2.75", expected_change_bp: "0.25", interval_valid: "true" });
    expect(cells(lines[3])).toMatchObject({
      kalshi_valid: "false",
      kalshi_exclusion: "expected_missing:coverage",
      interval_exclusion: "expected_missing",
      sum_p: "",
      open_outcomes: "",
    });
  });

  it("keeps one market's columns for a probability", () => {
    expect(researchCsvColumns(probabilityVariable("Hike 25bps"))).toEqual([...RESEARCH_CSV_COLUMNS]);
    expect(researchCsvColumns()).toEqual([...RESEARCH_CSV_COLUMNS]);
  });
});
