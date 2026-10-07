import { describe, expect, it } from "vitest";
import type { GroupTests, TestResult } from "@/lib/analytics";
import { eventFamilyText } from "./stats";

function result(p: number | null, pUnavailable: TestResult["pUnavailable"]): TestResult {
  return {
    estimate: 0.1,
    ci: null,
    p,
    holm: p,
    bh: p,
    role: "exploratory",
    family: null,
    method: "sign_flip",
    interval: "event_bootstrap",
    resampling: null,
    n: 6,
    nEffective: null,
    pUnavailable,
    ciUnavailable: null,
  };
}

/** A direction with 12 bars around the reference bar (hourly), all tested or none. */
function group(why: TestResult["pUnavailable"]): GroupTests {
  const test = () => (why === null ? result(0.2, null) : result(null, why));
  return { bars: [...Array.from({ length: 5 }, test), null, ...Array.from({ length: 7 }, test)], path: test() };
}

describe("eventFamilyText", () => {
  it("counts the bars of each direction when both were tested", () => {
    expect(eventFamilyText({ rises: group(null), falls: group(null) })).toBe(
      "The 24 tested bars (12 after rises, 12 after falls) are corrected together as one family, and the two whole-path tests as another.",
    );
  });

  it("names only the direction that was tested, and why the other wasn't", () => {
    expect(eventFamilyText({ rises: group(null), falls: group("too_few_events") })).toBe(
      "Only rises were tested (there were fewer than 5 falls). Their 12 bars are corrected as one family; with no whole-path test for falls, the one for rises needs no correction.",
    );
    expect(eventFamilyText({ rises: group("too_few_events"), falls: group(null) })).toMatch(/^Only falls were tested \(there were fewer than 5 rises\)\./);
  });

  it("says no bars were tested when neither direction had enough jumps", () => {
    expect(eventFamilyText({ rises: group("too_few_events"), falls: group("too_few_events") })).toBe(
      "No bars were tested because there were too few jumps: a test needs at least 5 rises or 5 falls.",
    );
    expect(eventFamilyText({ rises: group("no_variation"), falls: group("too_few_events") })).toBe("No bars could be tested.");
  });
});
