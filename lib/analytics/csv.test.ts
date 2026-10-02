import { describe, expect, it } from "vitest";
import { csvField, RESEARCH_CSV_COLUMNS, researchCsv } from "./csv";
import { buildResearchRows } from "./research";

// 10:00 and 11:00 AM New York on Mon, Sep 28, 2026 (EDT), then 10:00 AM on Mon, Nov 2 (EST).
const T1 = Date.parse("2026-09-28T14:00:00Z");
const T2 = Date.parse("2026-09-28T15:00:00Z");
const T3 = Date.parse("2026-11-02T15:00:00Z");

describe("researchCsv", () => {
  const rows = buildResearchRows({
    stock: [
      { t: T1, value: 100 },
      { t: T2, value: 101.5 },
      { t: T3, value: 99 },
    ],
    kalshi: [
      { t: T1 - 3600_000, value: 0.4, source: "midpoint" },
      { t: T2, value: 0.425, source: "midpoint" },
      { t: T3 - 3600_000, value: 0.5, source: "last_price" },
    ],
    closeTime: null,
    resolution: "hourly",
  });
  const lines = researchCsv(rows, "hourly").split("\r\n");

  it("writes a header, one line per row, and a final line break", () => {
    expect(lines[0]).toBe(RESEARCH_CSV_COLUMNS.join(","));
    expect(lines).toHaveLength(rows.length + 2);
    expect(lines.at(-1)).toBe("");
  });

  it("writes UTC and New York timestamps with their offsets", () => {
    expect(lines[1].startsWith("2026-09-28T14:00:00Z,2026-09-28T10:00:00-04:00,hourly,")).toBe(true);
    expect(lines[3].startsWith("2026-11-02T15:00:00Z,2026-11-02T10:00:00-05:00,")).toBe(true);
  });

  it("writes every row with its validity, leaving missing values empty", () => {
    const cells = (line: string) => Object.fromEntries(line.split(",").map((v, i) => [RESEARCH_CSV_COLUMNS[i], v]));
    expect(cells(lines[1])).toMatchObject({
      kalshi_probability: "0.4",
      kalshi_as_of_utc: "2026-09-28T13:00:00Z",
      kalshi_valid: "true",
      kalshi_exclusion: "",
      interval_valid: "false",
      interval_exclusion: "first_row",
      prob_change_pp: "",
      stock_log_return: "",
    });
    const second = cells(lines[2]);
    expect(second).toMatchObject({ interval_valid: "true", interval_exclusion: "", kalshi_source: "midpoint" });
    expect(Number(second.prob_change_pp)).toBeCloseTo(2.5, 10);
    expect(Number(second.stock_log_return)).toBeCloseTo(Math.log(1.015), 14);
    expect(cells(lines[3])).toMatchObject({
      kalshi_valid: "false",
      kalshi_exclusion: "kalshi_last_price",
      interval_valid: "false",
      interval_exclusion: "non_trading",
    });
  });
});

describe("researchCsv with a benchmark", () => {
  const rows = buildResearchRows({
    stock: [
      { t: T1, value: 100 },
      { t: T2, value: 101.5 },
      { t: T3, value: 99 },
    ],
    kalshi: [{ t: T1, value: 0.4, source: "midpoint" }],
    closeTime: null,
    resolution: "hourly",
  });
  const cells = (line: string) => Object.fromEntries(line.split(",").map((v, i) => [RESEARCH_CSV_COLUMNS[i], v]));

  it("appends the benchmark's close and return, and both adjusted returns", () => {
    const lines = researchCsv(rows, "hourly", {
      symbol: "SPY",
      closesByT: new Map([
        [T1, 500],
        [T2, 502],
      ]),
      model: { alpha: 0.0001, beta: 1.2 },
    }).split("\r\n");
    expect(lines[0].endsWith(",benchmark_symbol,benchmark_close,benchmark_log_return,market_beta,market_alpha,abnormal_log_return,excess_log_return")).toBe(true);
    expect(cells(lines[1])).toMatchObject({ benchmark_symbol: "SPY", benchmark_close: "500", benchmark_log_return: "", abnormal_log_return: "" });
    const second = cells(lines[2]);
    const r = Math.log(1.015);
    const rm = Math.log(502 / 500);
    expect(second).toMatchObject({ benchmark_close: "502", market_beta: "1.2", market_alpha: "0.0001" });
    expect(Number(second.benchmark_log_return)).toBeCloseTo(rm, 15);
    expect(Number(second.abnormal_log_return)).toBeCloseTo(r - 0.0001 - 1.2 * rm, 15);
    expect(Number(second.excess_log_return)).toBeCloseTo(r - rm, 15);
    // No benchmark bar at T3.
    expect(cells(lines[3])).toMatchObject({ benchmark_close: "", benchmark_log_return: "", abnormal_log_return: "", excess_log_return: "" });
  });

  it("leaves the benchmark columns empty without a benchmark, and beta-adjusted ones without a model", () => {
    const empty = cells(researchCsv(rows, "hourly").split("\r\n")[2]);
    expect(empty).toMatchObject({ benchmark_symbol: "", benchmark_close: "", market_beta: "", excess_log_return: "" });
    const noModel = cells(researchCsv(rows, "hourly", { symbol: "SPY", closesByT: new Map([[T1, 500], [T2, 502]]), model: null }).split("\r\n")[2]);
    expect(noModel.market_beta).toBe("");
    expect(noModel.abnormal_log_return).toBe("");
    expect(Number(noModel.excess_log_return)).toBeCloseTo(Math.log(1.015) - Math.log(502 / 500), 15);
  });
});

describe("csvField", () => {
  it("quotes only fields that need it, doubling inner quotes", () => {
    expect(csvField("plain")).toBe("plain");
    expect(csvField('say "hi", ok')).toBe('"say ""hi"", ok"');
    expect(csvField("two\nlines")).toBe('"two\nlines"');
    expect(csvField(null)).toBe("");
    expect(csvField(false)).toBe("false");
    expect(csvField(-0.25)).toBe("-0.25");
  });
});
