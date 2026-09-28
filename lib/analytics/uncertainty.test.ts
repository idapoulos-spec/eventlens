import { describe, expect, it } from "vitest";
import { binaryEntropy, uncertaintyScore } from "./uncertainty";

describe("binaryEntropy", () => {
  it("is 1 bit at a coin flip", () => {
    expect(binaryEntropy(0.5)).toBe(1);
  });

  it("matches the Shannon entropy formula", () => {
    // -(0.25 log2 0.25 + 0.75 log2 0.75)
    expect(binaryEntropy(0.25)).toBeCloseTo(0.8112781244591328, 12);
  });

  it("is symmetric around 0.5", () => {
    expect(binaryEntropy(0.2)).toBeCloseTo(binaryEntropy(0.8)!, 12);
  });

  it("is 0 at 0% and 100%", () => {
    expect(binaryEntropy(0)).toBe(0);
    expect(binaryEntropy(1)).toBe(0);
  });

  it("is small but positive just inside 0 and 1", () => {
    for (const p of [1e-12, 1 - 1e-12]) {
      const h = binaryEntropy(p)!;
      expect(h).toBeGreaterThan(0);
      expect(h).toBeLessThan(1e-9);
    }
  });

  it("returns null outside 0–1", () => {
    expect(binaryEntropy(-0.01)).toBeNull();
    expect(binaryEntropy(1.01)).toBeNull();
    expect(binaryEntropy(-1)).toBeNull();
    // A percentage passed where a probability was expected.
    expect(binaryEntropy(50)).toBeNull();
  });

  it("returns null for non-finite input", () => {
    expect(binaryEntropy(Number.NaN)).toBeNull();
    expect(binaryEntropy(Number.POSITIVE_INFINITY)).toBeNull();
    expect(binaryEntropy(Number.NEGATIVE_INFINITY)).toBeNull();
  });
});

describe("uncertaintyScore", () => {
  it("is 100 at a coin flip", () => {
    expect(uncertaintyScore(0.5)).toBe(100);
  });

  it("scales entropy to 0–100", () => {
    expect(uncertaintyScore(0.25)).toBeCloseTo(81.12781244591328, 10);
  });

  it("is 0 at 0% and 100%", () => {
    expect(uncertaintyScore(0)).toBe(0);
    expect(uncertaintyScore(1)).toBe(0);
  });

  it("returns null for a missing probability", () => {
    expect(uncertaintyScore(null)).toBeNull();
  });

  it("returns null outside 0–1 or for non-finite input", () => {
    expect(uncertaintyScore(-0.5)).toBeNull();
    expect(uncertaintyScore(1.5)).toBeNull();
    expect(uncertaintyScore(Number.NaN)).toBeNull();
  });
});
