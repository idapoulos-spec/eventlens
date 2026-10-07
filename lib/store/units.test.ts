import { describe, expect, it } from "vitest";
import { contractsToHundredths, dollarsToMicros, hundredthsToContracts, microsToDollars } from "./units";

describe("Kalshi prices as micro-dollars", () => {
  it("converts Kalshi's dollar strings exactly, up to 6 decimals", () => {
    expect(dollarsToMicros("0.4500")).toBe(450000);
    expect(dollarsToMicros("0.6967")).toBe(696700);
    expect(dollarsToMicros("0.123457")).toBe(123457);
    expect(dollarsToMicros("0.0000")).toBe(0);
    expect(dollarsToMicros("1.0000")).toBe(1_000_000);
    expect(microsToDollars(450000)).toBe(0.45);
  });

  it("keeps missing values missing", () => {
    for (const missing of [null, undefined, "", "n/a"]) expect(dollarsToMicros(missing)).toBeNull();
    expect(microsToDollars(null)).toBeNull();
  });

  it("refuses prices a YES contract can't have", () => {
    expect(() => dollarsToMicros("1.01")).toThrow(RangeError);
    expect(() => dollarsToMicros("-0.01")).toThrow(RangeError);
  });

  it("round-trips every cent", () => {
    for (let cents = 0; cents <= 100; cents++) {
      const dollars = (cents / 100).toFixed(4);
      expect(microsToDollars(dollarsToMicros(dollars))).toBe(Number(dollars));
    }
  });
});

describe("Kalshi contract counts as hundredths", () => {
  it("converts fixed-point counts exactly", () => {
    expect(contractsToHundredths("10.00")).toBe(1000);
    expect(contractsToHundredths("15760947.00")).toBe(1_576_094_700);
    expect(contractsToHundredths("0.01")).toBe(1);
    expect(hundredthsToContracts(1_576_094_700)).toBe(15_760_947);
    expect(contractsToHundredths(null)).toBeNull();
    expect(() => contractsToHundredths("-1.00")).toThrow(RangeError);
  });
});
