import { describe, expect, it } from "vitest";
import { eventStudyChart, leadLagChart, niceTicks, rollingChart, SERIES, tickLabel } from "./charts";

/** The text a chart shows: its <title> and every <text>. */
const texts = (svg: string) => [...svg.matchAll(/<(text|title)\b[^>]*>([^<]*)<\/\1>/g)].map((m) => m[2]);
const count = (svg: string, pattern: RegExp) => (svg.match(pattern) ?? []).length;

describe("niceTicks and tickLabel", () => {
  it("pick round ticks across a range, labeled with as few decimals as the step needs", () => {
    expect(niceTicks(-0.37, 0.52)).toEqual([-0.25, 0, 0.25, 0.5]);
    expect(niceTicks(0, 10)).toEqual([0, 2.5, 5, 7.5, 10]);
    expect([-0.25, 0, 0.5].map((v) => tickLabel(v, 0.25))).toEqual(["−0.25", "0", "+0.50"]);
    expect(tickLabel(0.4, 0.2, "%")).toBe("+0.4%");
    expect(tickLabel(5, 5)).toBe("+5");
  });
});

describe("leadLagChart", () => {
  const points = [
    { label: "−1h", r: -0.05, ci: [-0.2, 0.1] as [number, number], primary: false },
    { label: "0h", r: 0.12, ci: [-0.02, 0.26] as [number, number], primary: true },
    { label: "+1h", r: null, ci: null, primary: false },
  ];

  it("draws a dot for each lag with an r and a whisker for each interval, and names the primary lag", () => {
    const svg = leadLagChart(points, "Lead-lag");
    expect(count(svg, /<circle /g)).toBe(2);
    expect(count(svg, new RegExp(`<line [^>]*stroke="${SERIES[0]}"`, "g"))).toBe(2);
    expect(texts(svg)).toContain("0h (primary)");
  });

  it("shows only its title, the lags, and the axis's ticks: no data values as text", () => {
    const svg = leadLagChart(points, "Lead-lag");
    const ticks = texts(svg).filter((t) => !["Lead-lag", "−1h", "0h (primary)", "+1h"].includes(t));
    for (const t of ticks) expect(t, t).toMatch(/^(0|[+−]0\.\d+)$/);
    expect(texts(svg).some((t) => t.includes("0.12") || t.includes("0.26"))).toBe(false);
  });
});

describe("rollingChart", () => {
  it("draws one line, broken where the correlation is undefined", () => {
    const svg = rollingChart(
      [
        { t: 0, r: 0.1 },
        { t: 1, r: 0.2 },
        { t: 2, r: null },
        { t: 3, r: -0.1 },
        { t: 4, r: 0 },
      ],
      "Rolling",
      (t) => `day ${t}`,
    );
    expect(count(svg, /<path /g)).toBe(1);
    expect(count(svg, /M\d/g)).toBe(2);
    expect(texts(svg)).toEqual(expect.arrayContaining(["day 0", "day 4"]));
  });
});

describe("eventStudyChart", () => {
  const labels = ["−1h", "0h", "+1h"];
  const group = (name: string) => ({ name, mean: [0, 0.1, 0.2], band: [null, [-0.1, 0.3], [0, 0.4]] as ([number, number] | null)[] });

  it("draws each group's path and band and the baseline, with a legend of their names", () => {
    const svg = eventStudyChart({ labels, groups: [group("After rises (n = 7)"), group("After falls (n = 6)")], baseline: [0, 0.01, 0.02] }, "Event study");
    expect(count(svg, /fill-opacity="0.1"/g)).toBe(2);
    expect(count(svg, /<path d="M[^"]*" fill="none"/g)).toBe(3);
    expect(texts(svg)).toEqual(expect.arrayContaining(["After rises (n = 7)", "After falls (n = 6)", "Baseline (normal drift)", ...labels]));
  });

  it("draws no path for a group it isn't given (the report leaves out groups with too few events)", () => {
    const svg = eventStudyChart({ labels, groups: [group("After rises (n = 7)")], baseline: [0, 0.01, 0.02] }, "Event study");
    expect(count(svg, /<path d="M[^"]*" fill="none"/g)).toBe(2);
    expect(svg).not.toContain("After falls");
    expect(svg).not.toContain(SERIES[1]);
    expect(() => eventStudyChart({ labels, groups: [group("a"), group("b"), group("c")], baseline: [] }, "x")).toThrow();
  });
});
