import { describe, expect, it } from "vitest";
import { chanceLine, correlationNote, medianAbs, survivorsLine } from "./text";

describe("the scan page's wording", () => {
  it("gives the chance baseline next to the count of small p-values", () => {
    expect(chanceLine(6, 97)).toBe("p under 0.05 before any correction: 6 of 97, about 4.9 expected by chance alone if none were related.");
    expect(chanceLine(0, 10)).toContain("about 0.5 expected");
  });

  it("says what surviving each correction means", () => {
    expect(survivorsLine(0, 1)).toBe(
      "Survive Holm: 0 (the chance of any false lead in this scan is held at 5%). Survive Benjamini–Hochberg: 1 (on average, at most 5% of the surviving leads are false).",
    );
  });

  it("names the series and events whose candidates move together", () => {
    const fed = (n: number) => Array.from({ length: n }, (_, i) => ({ series: "KXFEDDECISION", event: `KXFEDDECISION-${i}` }));
    expect(correlationNote([...fed(26), { series: "KXCPI", event: "KXCPI-26OCT" }, { series: "KXCPI", event: "KXCPI-26OCT" }, { series: null, event: "X" }, { series: "KXGDP", event: "KXGDP-1" }])).toBe(
      "26 of 30 are in KXFEDDECISION; 2 of 30 are in KXCPI. 1 event has more than one outcome listed, and outcomes of one event are near-duplicates. Candidates in the same series or event tend to move together, so their results are correlated: several similar results there are not independent confirmations.",
    );
    expect(correlationNote([{ series: "A", event: "A-1" }, { series: "B", event: "B-1" }])).toBeNull();
  });

  it("takes the median of |r|", () => {
    expect(medianAbs([0.1, -0.4, 0.2])).toBe(0.2);
    expect(medianAbs([0.1, -0.3])).toBe(0.2);
    expect(medianAbs([])).toBeNull();
  });
});
