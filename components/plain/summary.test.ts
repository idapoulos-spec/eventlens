import { describe, expect, it } from "vitest";
import type { LagCorrelation } from "@/lib/analytics";
import { formatSigned } from "@/lib/format";
import { WARNING_BY_CHANCE } from "../research/ResearchPanel";
import { analysisScenarios, base, ruleInput, RULES, SCAN_CANDIDATES, scanScenarios, scanSnap } from "./scenarios";
import { LEVEL_LABEL, plainSummary, RATING_METHOD, RATING_METHOD_NUMBERS, scanPlainSummary, smallLinkText, STRONG_MISS_90, WARNING_RATE, type PlainSummary } from "./summary";
import { EVENT, MARKET, plainInput, summaryText, withParts } from "./test-helpers";
import { numbersIn } from "../report/test-helpers";

const section = (s: PlainSummary, id: string) => s.sections.find((x) => x.id === id)!.items.join("\n");
const summary = (name: (typeof RULES)[number], over = {}) => plainSummary(ruleInput(name, over));

describe("the headline and the evidence, rule by rule", () => {
  it("says which way the stock moved, how much, and that returns are market-adjusted, for Moderate and Strong", () => {
    const strong = summary("strong");
    expect(strong.level).toBe("strong");
    expect(strong.headline).toBe("When the chance of “Fed maintains rate” rose, TLT tended to fall somewhat in the same hour, beyond what moves in SPY explain.");
    expect(section(strong, "evidence")).toContain("The main test’s p-value is 0.001, under 0.005. It held up when each of the 10 trading days that mattered most was left out.");
    expect(section(strong, "evidence")).toContain("Main test: correlation r = −0.21 (95% range −0.28 to −0.14), p-value 0.001.");
    const moderate = summary("moderate", { variable: EVENT, resolution: "daily" });
    expect(moderate.headline).toBe("When the expected rate change rose, TLT tended to rise clearly in the same trading day, beyond what moves in SPY explain.");
    expect(section(moderate, "evidence")).toContain("Strong needs a p-value under 0.005.");
    expect(section(summary("strong", { resolution: "daily", choice: 365, longDaily: true }), "evidence")).toContain("It isn’t rated Strong because, in tests, daily data over long windows");
  });

  it("hedges a fragile result and says why it's only Weak", () => {
    const weak = summary("fragile_loo");
    expect(weak.level).toBe("weak");
    expect(weak.headline).toBe("A weak sign: when the chance of “Fed maintains rate” rose, TLT tended to rise slightly in the same hour, beyond what moves in SPY explain.");
    expect(section(weak, "evidence")).toContain("But the result is fragile. Leaving out one of the 10 trading days that mattered most changed it in 2 of 10 tries. Fragile results are never rated above Weak.");
    const both = section(summary("fragile_both"), "evidence");
    expect(both).toContain("Kalshi’s movement was bunched into a few hours, worth only about 7.4 equal hours of movement.");
    expect(both).toContain("changed it in 1 of 10 tries");
    expect(section(summary("fragile_unchecked"), "evidence")).toContain("couldn’t run, so it counts as fragile");
    expect(section(summary("no_interval"), "evidence")).toContain("couldn’t give a range for the link, so it’s rated Weak");
  });

  it("says Not enough data, not No clear link, without the moves or the power to find a medium link", () => {
    for (const name of ["no_p", "few_moves", "low_power", "low_power_capped", "low_power_missing"] as const) {
      const s = summary(name);
      expect(s.level, name).toBe("not_enough_data");
      expect(s.headline).toBe("Not enough data to tell whether TLT moved with the chance of “Fed maintains rate” in the same hour, beyond what moves in SPY explain.");
    }
    expect(section(summary("no_p"), "evidence")).toContain("This window holds only 62 trading days with data, too few for the main test (it needs at least 8).");
    expect(section(summary("few_moves"), "evidence")).toContain("worth only about 6.3 equal hours of movement. So a real link could easily be missed.");
    expect(section(summary("low_power"), "evidence")).toContain("only a link of about ±0.35 or stronger would be found 80% of the time. So a real but weaker link could easily be missed. “No clear link” needs ±0.30 or better.");
    expect(section(summary("low_power_capped"), "evidence")).toContain("only a link stronger than about ±0.8 would be found 80% of the time");
    // An optimistic detectable size (30 days) turns No clear link into Not enough data.
    const miss = summary("no_link", { choice: 30 });
    expect(miss.level).toBe("not_enough_data");
    expect(section(miss, "evidence")).toContain("too hopeful for 30-day windows");
  });

  it("says No clear link with the size it could have found, and that a weaker one isn't ruled out", () => {
    const s = summary("no_link", { stock: "NVDA", choice: 365 });
    expect(s.level).toBe("no_clear_link");
    expect(s.headline).toBe("No clear link between the chance of “Fed maintains rate” and NVDA in the same hour, beyond what moves in SPY explain.");
    expect(section(s, "evidence")).toContain("a link of about ±0.18 or stronger would have been found 80% of the time. So a strong link is unlikely, but a weaker one can’t be ruled out.");
  });

  it("waits, and says it's checking, while a result the rating needs is computing", () => {
    for (const name of ["pending_significant", "pending_not_significant"] as const) {
      const s = summary(name);
      expect(s.level).toBe("pending");
      expect(s.headline).toBe("Working out what this window shows about TLT and the chance of “Fed maintains rate”…");
    }
    expect(section(summary("pending_significant"), "evidence")).toContain("Checking how much the result rests on a few trading days…");
    expect(section(summary("pending_not_significant"), "evidence")).toContain("Working out how big a link this much data could find…");
  });

  it("gives no rating without a primary test, and says why", () => {
    const { results } = base();
    const s = plainSummary(plainInput({ ...results, market: { ...results.market!, primary: null, kalshi: null } }, { unavailable: "TLT is the benchmark itself" }));
    expect(s.level).toBe("none");
    expect(s.headline).toBe("No main test in this view: TLT is the benchmark itself.");
    expect(section(s, "evidence")).toBe("No rating: the main test can’t run here (TLT is the benchmark itself).");
  });
});

describe("the small-link note", () => {
  it("appears exactly when the rating is Moderate or Strong and |r| is below 0.10", () => {
    for (const variable of [MARKET, EVENT]) {
      for (const name of RULES) {
        const s = summary(name, { variable });
        const small = ["strong_small", "moderate_small"].includes(name);
        const note = smallLinkText(variable.kind === "probability" ? "Kalshi’s" : "the expected rate change’s", "TLT");
        expect(section(s, "evidence").includes(note), `${variable.kind} ${name}`).toBe(small);
      }
    }
    expect(section(summary("strong_small"), "evidence")).toContain("The evidence is convincing, but the link itself is small: Kalshi’s moves explain only a tiny part of how TLT moved.");
    expect(summary("strong_small").level).toBe("strong");
    expect(summary("moderate_small").level).toBe("moderate");
  });

  it("appears for a scan's lead on the same terms", () => {
    const scans = Object.fromEntries(scanScenarios().map((s) => [s.name, s.summary]));
    expect(section(scans["scan strong small link"], "scan-lead")).toContain("but the link itself is small: the expected rate change’s moves explain only a tiny part of how TLT moved.");
    expect(section(scans["scan moderate small link, market lead"], "scan-lead")).toContain("but the link itself is small: Kalshi’s moves");
    for (const name of ["scan strong", "scan moderate", "scan fragile (F3)", "scan nothing stood out"]) expect(section(scans[name], "scan-lead")).not.toContain("the link itself is small");
  });
});

describe("how big", () => {
  it("rescales the regression to 10 pp for a market and 25 bp for an event, with its range", () => {
    const { results } = base();
    const fit = results.market!.kalshi!;
    for (const [variable, scale] of [[MARKET, 10], [EVENT, 25]] as const) {
      const s = plainSummary(plainInput(results, { variable, leaveOneOut: base().loo }));
      const size = section(s, "size");
      expect(size).toContain(`went with about a ${formatSigned(fit.coef * scale, 2, "%")} move in TLT in the same hour.`);
      expect(size).toContain(`The likely range is ${formatSigned(fit.test.ci![0] * scale, 2, "%")} to ${formatSigned(fit.test.ci![1] * scale, 2, "%")}.`);
      expect(s.derived).toEqual(expect.arrayContaining([formatSigned(fit.coef * scale, 2, "%"), String(scale)]));
    }
    expect(section(plainSummary(plainInput(results, { variable: MARKET })), "size")).toContain("Take a 10-percentage-point rise in the chance of “Fed maintains rate”, say from 40% to 50%.");
    expect(section(plainSummary(plainInput(results, { variable: EVENT })), "size")).toContain("Take a 25-basis-point rise in the expected rate change, the size of one usual Fed move.");
  });

  it("says when the range includes zero, when the size points the other way, and when there's no size", () => {
    const { results } = base();
    const at = (coef: number, ci: [number, number] | null, r: number) =>
      section(plainSummary(plainInput(withParts(results, { kalshi: { coef, test: { ...results.market!.kalshi!.test, ci } }, primary: { ...results.market!.primary!, estimate: r } }))), "size");
    expect(at(0.01, [-0.005, 0.02], 0.1)).toContain("The range includes zero, so the true effect could be none at all.");
    expect(at(0.01, [0.004, 0.02], 0.1)).not.toContain("includes zero");
    expect(at(0.01, [0.004, 0.02], -0.1)).toContain("points the other way from the main test");
    expect(at(0.01, null, 0.1)).toContain("The test couldn’t give a range for it.");
    expect(section(plainSummary(plainInput(withParts(results, { kalshi: null }))), "size")).toBe("There’s too little data to put a size on it.");
  });
});

describe("does Kalshi move first", () => {
  const lagged = (passing: Record<number, number>) => {
    const { results } = base();
    const lags: LagCorrelation[] = results.view.lags.map((l) =>
      l.test.role === "primary" ? l : { ...l, test: { ...l.test, p: passing[l.lag] ?? 0.5, bh: passing[l.lag] ?? 0.8, holm: passing[l.lag] ?? 1 } },
    );
    return section(plainSummary(plainInput({ ...results, view: { ...results.view, lags } })), "lead");
  };

  it("names a lag that passes correction as a lead to check, either way, and always says moving together isn't predicting", () => {
    expect(lagged({ 2: 0.001 })).toContain("Maybe: TLT tended to move 2 hours after Kalshi did, even after correcting for checking 6 time shifts. That’s a lead to check, not a finding.");
    expect(lagged({ [-1]: 0.001 })).toContain("If anything, TLT moved first: Kalshi tended to move 1 hour after TLT did");
    expect(lagged({ 1: 0.001, [-3]: 0.002 })).toMatch(/Maybe: .* Also, TLT moved first: Kalshi tended to move 3 hours after TLT did/);
    expect(lagged({})).toContain("No clear sign: after correcting for checking 6 time shifts, neither tended to move first.");
    for (const text of [lagged({ 2: 0.001 }), lagged({})]) expect(text).toContain("Moving together in the same hour isn’t the same as predicting");
  });

  it("says when the lags use raw returns", () => {
    const raw = analysisScenarios().find((s) => s.name === "market raw returns")!.summary;
    expect(section(raw, "lead")).toContain("This uses raw returns, as picked above, so market-wide moves are still in them.");
    expect(section(summary("strong"), "lead")).not.toContain("raw returns");
  });
});

describe("how much to trust it", () => {
  it("names the fragile checks with the warning's chance rate for the window, or says it's stable", () => {
    const fragile = section(summary("fragile_loo"), "trust");
    expect(fragile).toContain("This result is fragile. Leaving out one of the 10 trading days that mattered most changed it in 2 of 10 tries.");
    expect(fragile).toContain("Even with no real link, this warning comes on by chance in 22.5% of 90-day windows in tests.");
    for (const [rate] of Object.values(WARNING_RATE)) expect(WARNING_BY_CHANCE).toContain(rate);
    expect(section(summary("fragile_loo", { resolution: "daily" }), "trust")).not.toContain("by chance in");
    expect(section(summary("strong"), "trust")).toContain("Stable: leaving out any one of the 10 trading days that mattered most didn’t change the result.");
  });

  it("gives the sample, short windows, the data's source, and whether the numbers will change", () => {
    const s = section(summary("strong"), "trust");
    expect(s).toMatch(/^Based on [\d,]+ trading hours in a 90-day window; Kalshi moved in [\d,]+ of them, across 62 trading days\.$/m);
    expect(s).toContain("Kalshi’s history here comes straight from Kalshi.");
    expect(s).toContain("The window ends now, so these numbers will change as new data comes in. Freeze the view to keep them.");
    expect(section(summary("strong", { choice: 30 }), "trust")).toContain("Short window: only 30 days of hourly data, so results can swing a lot.");
    const stored = section(summary("strong", { sources: { provenance: { storedThrough: 1, liveFrom: 2, liveFailed: false } }, frozenAt: 3 }), "trust");
    expect(stored).toContain("from EventLens’s stored copy, with live data after that.");
    expect(stored).toContain("Frozen: this view’s link gives these same numbers later.");
    expect(section(summary("strong", { windowEnd: 5, variable: EVENT }), "trust")).toContain("The window ends at the event’s close");
  });

  it("discloses the 90-day Strong miss, the daily long-window intervals, and settings the rating wasn't simulated at", () => {
    expect(section(summary("strong"), "trust")).toContain(`90-day hourly windows were rated Strong ${STRONG_MISS_90} of the time, more than the 1% aimed for.`);
    for (const over of [{ choice: 180 }, { choice: 90, resolution: "daily" }]) expect(section(summary("strong", over), "trust")).not.toContain("rated Strong 1.8%");
    expect(section(summary("moderate"), "trust")).not.toContain("rated Strong 1.8%");
    expect(section(summary("strong", { resolution: "daily", choice: 365, longDaily: true }), "trust")).toContain("They held the true value 90% of the time, not 95%.");
    for (const over of [{ resolution: "daily" }, { choice: 365 }, { choice: "all" }]) expect(section(summary("strong", over), "trust")).toContain("this setting wasn’t simulated");
    for (const over of [{}, { choice: 30 }, { choice: 180 }]) expect(section(summary("strong", over), "trust")).not.toContain("wasn’t simulated");
  });
});

describe("a scan's summary", () => {
  const scans = Object.fromEntries(scanScenarios().map((s) => [s.name, s.summary]));
  const settings = { stock: "TLT", choice: 90 as const, resolution: "hourly" as const, candidates: SCAN_CANDIDATES };

  it("counts survivors after correction, and puts what chance alone gives next to the uncorrected count", () => {
    expect(scans["scan strong"].headline).toBe(
      "Out of 3 markets and events tested, 1 still looked related after correcting for testing many at once. 1 also passed the stricter check. Before correcting, 1 had p-values under 0.05, where about 0.2 would be expected by chance alone even if none were related.",
    );
    expect(scans["scan moderate small link, market lead"].headline).toContain("None passed the stricter check.");
    expect(scans["scan nothing stood out"].headline).toMatch(/^Out of 3 markets and events tested, none still looked related after correcting for testing many at once\. Before correcting/);
    expect(scans["scan still running"].headline).toMatch(/^So far, out of 2 markets and events tested/);
    expect(scans["scan with an untested candidate"].headline).toMatch(/^Out of 2 markets and events tested/);
  });

  it("rates the strongest lead on its corrected p, with Nothing stood out when it doesn't survive", () => {
    expect(scans["scan strong"].level).toBe("strong");
    expect(section(scans["scan strong"], "scan-lead")).toContain(
      "The strongest lead is “Fed decision in Dec 2025” (KXFEDDECISION-25DEC). When the expected rate change rose, TLT tended to fall somewhat in the same hour, beyond what moves in SPY explain. Its correlation: r = −0.21 (95% range −0.30 to −0.12). It survives the correction with a corrected p-value under 0.005.",
    );
    expect(scans["scan moderate"].level).toBe("moderate");
    expect(scans["scan moderate, daily past 90 days"].level).toBe("moderate");
    expect(section(scans["scan moderate, daily past 90 days"], "scan-lead")).toContain("It isn’t rated Strong because");
    expect(scans["scan fragile (F3)"].level).toBe("weak");
    expect(section(scans["scan fragile (F3)"], "scan-lead")).toContain("changed it in 3 of 10 tries");
    expect(scans["scan fragile (F1)"].level).toBe("weak");
    expect(scans["scan pending leave-one-out"].level).toBe("pending");
    expect(scans["scan still running"].level).toBe("pending");
    expect(scans["scan nothing stood out"].level).toBe("nothing_stood_out");
    expect(LEVEL_LABEL.nothing_stood_out).toBe("Nothing stood out");
    expect(section(scans["scan nothing stood out"], "scan-lead")).toContain(
      "It didn’t survive the correction for testing many at once. A scan doesn’t check how big a link each one’s data could find; its own page does. On its own page it may look stronger, because that page doesn’t correct for the other 2 tests.",
    );
    expect(scans["scan not enough data (F1)"].level).toBe("not_enough_data");
    for (const s of Object.values(scans).filter((s) => s.sections.some((x) => x.id === "scan-lead"))) {
      expect(section(s, "scan-lead")).toContain("Leads at the top of a scan are probably overstated, because they rank first partly by luck.");
    }
  });

  it("says when nothing could be tested, or nothing has finished", () => {
    expect(scans["scan nothing tested"].headline).toBe("None of the candidates could be tested.");
    expect(scans["scan just started"].headline).toBe("Results appear here as each candidate finishes.");
    expect(scanPlainSummary({ ...settings, snap: scanSnap({ bh: 0.02, holm: 0.03 }) }).level).toBe("moderate");
  });
});

describe("how the rating works", () => {
  it("quotes only the rules' thresholds and the simulation's figures", () => {
    const text = RATING_METHOD.join(" ");
    expect(new Set(numbersIn(text))).toEqual(new Set(numbersIn(RATING_METHOD_NUMBERS.join(" "))));
    expect(text).toContain(`Strong came up in ${STRONG_MISS_90} of 90-day windows, more than the 1% aimed for.`);
    expect(summaryText(summary("strong"))).not.toContain("simulations with no real link, hourly data");
  });
});
