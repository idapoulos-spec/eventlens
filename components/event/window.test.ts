import { describe, expect, it } from "vitest";
import { outcomeColors } from "./colors";
import { windowed } from "./window";

describe("windowed", () => {
  const points = [
    { t: 0, value: 1 },
    { t: 10, value: 2 },
    { t: 20, value: null },
    { t: 30, value: 3 },
  ];

  it("starts with the value in effect at the window's start", () => {
    expect(windowed(points, 15)).toEqual([
      { t: 15, value: 2 },
      { t: 20, value: null },
      { t: 30, value: 3 },
    ]);
    expect(windowed(points, 20)).toEqual(points.slice(2));
    expect(windowed(points, -5)).toEqual(points);
  });

  it("holds the last value through a window after every point, and is empty without points", () => {
    expect(windowed(points, 40)).toEqual([{ t: 40, value: 3 }]);
    expect(windowed([], 40)).toEqual([]);
  });
});

describe("outcomeColors", () => {
  it("colors cuts blue and hikes red, lighter the larger the move, and no change gray", () => {
    const colors = outcomeColors([
      { ticker: "C50", value: -50 },
      { ticker: "C25", value: -25 },
      { ticker: "H0", value: 0 },
      { ticker: "H25", value: 25 },
      { ticker: "H50", value: 50 },
      { ticker: "H75", value: 75 },
    ]);
    expect([...colors]).toEqual([
      ["C25", "#2a78d6"],
      ["C50", "#6da7ec"],
      ["H25", "#c7474b"],
      ["H50", "#e48482"],
      ["H75", "#f1aeaa"],
      ["H0", "#898781"],
    ]);
  });
});
