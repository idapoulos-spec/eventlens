import { describe, expect, it } from "vitest";
import { changeSince, chartPoints, currentExpected, eventPhase, lastValid, outcomeRows, weightPoints, type OutcomeBook } from "./analysis";
import { Outcome, type ExpectedMark, type OutcomeHistory } from "./engine";
import { mapEvent } from "./mapping";
import type { ExpectedNow } from "./types";

const HOUR = 60 * 60 * 1000;
const T0 = Date.UTC(2026, 9, 7, 14);
const h = (n: number) => T0 + n * HOUR;

const outcome = (ticker: string, value: number, over: Partial<OutcomeHistory> = {}) =>
  new Outcome({ ticker, value, openTime: h(-100), closeTime: h(100), candles: [], covered: [{ from: h(-100), to: h(100) }], seed: null, ...over });

const mark = (t: number, value: number | null, over: Partial<ExpectedMark> = {}): ExpectedMark => ({
  t,
  value,
  sumP: value === null ? null : 1,
  openSet: ["E-C25", "E-H0"],
  p: value === null ? null : [0.2, 0.8],
  missing: value === null ? "coverage" : null,
  ...over,
});

describe("currentExpected", () => {
  it("applies the mark rules to the live books, using each outcome's history for rule 4", () => {
    const outcomes = [
      outcome("E-C25", -25),
      outcome("E-H0", 0),
      // No quote now, last estimated at 3¢: counts as 0.
      outcome("E-H25", 25, { candles: [{ endTs: h(-1), bid: 0.02, ask: 0.04 }] }),
    ];
    const books = new Map([
      ["E-C25", { bid: 0.19, ask: 0.21 }],
      ["E-H0", { bid: 0.79, ask: 0.81 }],
      ["E-H25", { bid: 0, ask: 1 }],
    ]);
    const { now, states } = currentExpected(outcomes, books, h(0));
    expect(now).toMatchObject({ t: h(0), missing: null, openSet: ["E-C25", "E-H0", "E-H25"] });
    expect(now.value).toBeCloseTo(-5, 12);
    expect(states.get("E-H25")).toEqual({ p: 0, rule: "4_zero" });
    expect(states.get("E-C25")).toEqual({ p: 0.2, rule: 1 });
  });

  it("is missing when a silent outcome's last estimate was above 5¢, or unknown, and after the first close", () => {
    const books = new Map([["E-H0", { bid: 0.79, ask: 0.81 }]]);
    const stale = [outcome("E-H0", 0), outcome("E-H25", 25, { candles: [{ endTs: h(-1), bid: 0.1, ask: 0.12 }] })];
    expect(currentExpected(stale, books, h(0)).now).toMatchObject({ value: null, missing: "stale_quote" });
    const unknown = [outcome("E-H0", 0), outcome("E-H25", 25, { seed: "unknown" })];
    expect(currentExpected(unknown, books, h(0)).now).toMatchObject({ value: null, missing: "history_incomplete" });
    expect(currentExpected([outcome("E-H0", 0, { closeTime: h(0) })], books, h(0)).now.missing).toBe("after_close");
  });
});

describe("changeSince", () => {
  const now: ExpectedNow = { t: h(0) + 40 * 60_000, value: -4, sumP: 1, openSet: ["E-C25", "E-H0"], missing: null };
  const marks = [mark(h(-24), -6), mark(h(-1), -3), mark(h(0), -4)];

  it("compares with the hourly mark at or before the lookback", () => {
    expect(changeSince(now, marks, HOUR)).toEqual({ value: -1, from: h(-1), unavailable: null });
    expect(changeSince(now, marks, 24 * HOUR)).toEqual({ value: 2, from: h(-24), unavailable: null });
  });

  it("gives no change without a current value, without a value then, or across different open outcomes", () => {
    expect(changeSince({ ...now, value: null }, marks, HOUR).unavailable).toBe("no_current");
    expect(changeSince(now, [mark(h(-1), null)], HOUR).unavailable).toBe("no_reference");
    expect(changeSince(now, [mark(h(-1), -3, { openSet: ["E-H0"] })], HOUR)).toEqual({ value: null, from: h(-1), unavailable: "outcome_set_changed" });
  });
});

describe("chart points", () => {
  it("keeps the marks where E changes and the last of each run, so steps and gaps draw as they are", () => {
    const marks = [mark(h(0), -3), mark(h(1), -3), mark(h(2), -3), mark(h(3), null), mark(h(4), null), mark(h(5), -2), mark(h(6), -2)];
    expect(chartPoints(marks)).toEqual([
      { t: h(0), value: -3 },
      { t: h(2), value: -3 },
      { t: h(3), value: null },
      { t: h(4), value: null },
      { t: h(5), value: -2 },
      { t: h(6), value: -2 },
    ]);
  });

  it("gives each outcome's share of Σp in the order given, 0 if it isn't open, and none where E is missing", () => {
    const marks = [mark(h(0), -5, { sumP: 1.25, p: [0.25, 1] }), mark(h(1), null)];
    expect(weightPoints(marks, ["E-C25", "E-H0", "E-H25"])).toEqual([
      { t: h(0), weights: [0.2, 0.8, 0] },
      { t: h(1), weights: null },
    ]);
  });

  it("rounds E to 0.001 and weights to 0.0001, so changes too small to see aren't sent", () => {
    const marks = [mark(h(0), -3.00001, { p: [0.200001, 0.799999] }), mark(h(1), -3.00002, { p: [0.200002, 0.799998] }), mark(h(2), -3.00003)];
    expect(chartPoints(marks)).toEqual([
      { t: h(0), value: -3 },
      { t: h(2), value: -3 },
    ]);
    expect(weightPoints(marks.slice(0, 2), ["E-C25", "E-H0"])).toEqual([
      { t: h(0), weights: [0.2, 0.8] },
      { t: h(1), weights: [0.2, 0.8] },
    ]);
  });

  it("finds the last mark with a value", () => {
    expect(lastValid([mark(h(0), -3), mark(h(1), -2), mark(h(2), null)])?.t).toBe(h(1));
    expect(lastValid([mark(h(0), null)])).toBeNull();
  });
});

describe("eventPhase", () => {
  const book = (status: string): OutcomeBook => ({ ticker: "E", label: null, status, result: null, openTime: null, closeTime: null, bid: null, ask: null });
  it("is open while any outcome trades, settled once all have, and closed in between", () => {
    expect(eventPhase([book("active"), book("finalized")])).toBe("open");
    expect(eventPhase([book("finalized"), book("finalized")])).toBe("settled");
    expect(eventPhase([book("closed"), book("finalized")])).toBe("closed");
    expect(eventPhase([book("initialized")])).toBe("not_trading");
  });
});

describe("outcomeRows", () => {
  const contract = (suffix: string, label: string, strike: Record<string, string>) => ({
    ticker: `E-${suffix}`,
    event_ticker: "E",
    yes_sub_title: label,
    custom_strike: strike,
  });
  const book = (ticker: string, label: string): OutcomeBook => ({ ticker, label, status: "active", result: null, openTime: null, closeTime: null, bid: 0.1, ask: 0.2 });

  it("orders outcomes by value, unmapped last, with each one's probability, rule, and weight", () => {
    const mapping = mapEvent([contract("H0", "Fed maintains rate", { Hike: "0" }), contract("C25", "Cut 25bps", { Cut: "25" })], true);
    const books = [book("E-H0", "Fed maintains rate"), book("E-C25", "Cut 25bps"), book("E-X", "Something")];
    const current: ExpectedNow = { t: h(0), value: -5, sumP: 1, openSet: ["E-C25", "E-H0"], missing: null };
    const states = new Map([
      ["E-C25", { p: 0.2, rule: 1 as const }],
      ["E-H0", { p: 0.8, rule: 1 as const }],
    ]);
    const rows = outcomeRows(books, mapping, current, states, null, true);
    expect(rows.map((r) => [r.ticker, r.value, r.p, r.weight, r.bid])).toEqual([
      ["E-C25", -25, 0.2, 0.2, 0.1],
      ["E-H0", 0, 0.8, 0.8, 0.1],
      ["E-X", null, null, null, 0.1],
    ]);
  });

  it("for a closed event, reads each probability from the last mark and shows no book", () => {
    const mapping = mapEvent([contract("H0", "Fed maintains rate", { Hike: "0" }), contract("C25", "Cut 25bps", { Cut: "25" })], true);
    const last = mark(h(-1), -5);
    const current: ExpectedNow = { t: last.t, value: -5, sumP: 1, openSet: last.openSet, missing: null };
    const rows = outcomeRows([book("E-H0", "Fed maintains rate"), book("E-C25", "Cut 25bps")], mapping, current, new Map(), last, false);
    expect(rows.map((r) => [r.ticker, r.p, r.weight, r.bid, r.rule])).toEqual([
      ["E-C25", 0.2, 0.2, null, null],
      ["E-H0", 0.8, 0.8, null, null],
    ]);
  });
});
