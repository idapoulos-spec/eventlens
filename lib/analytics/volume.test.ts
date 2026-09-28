import { describe, expect, it } from "vitest";
import { relativeVolume } from "./volume";

describe("relativeVolume", () => {
  it("expresses volume as a percentage of average volume", () => {
    expect(relativeVolume(84, 100)).toBe(84);
    expect(relativeVolume(2_500_000, 1_000_000)).toBe(250);
    expect(relativeVolume(100, 100)).toBe(100);
  });

  it("is 0 when nothing has traded", () => {
    expect(relativeVolume(0, 1_000)).toBe(0);
  });

  it("returns null when volume or average volume is missing", () => {
    expect(relativeVolume(null, 1_000)).toBeNull();
    expect(relativeVolume(500, null)).toBeNull();
    expect(relativeVolume(null, null)).toBeNull();
  });

  it("returns null for a zero or negative average", () => {
    expect(relativeVolume(500, 0)).toBeNull();
    expect(relativeVolume(500, -10)).toBeNull();
  });

  it("returns null for non-finite input instead of NaN or 0", () => {
    expect(relativeVolume(Number.NaN, 1_000)).toBeNull();
    expect(relativeVolume(500, Number.NaN)).toBeNull();
    expect(relativeVolume(500, Number.POSITIVE_INFINITY)).toBeNull();
  });
});
