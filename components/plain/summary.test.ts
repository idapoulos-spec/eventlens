import { describe, expect, it } from "vitest";
import type { LagCorrelation } from "@/lib/analytics";
import { formatSigned } from "@/lib/format";
import { WARNING_BY_CHANCE } from "../research/ResearchPanel";
import { analysisScenarios, base, ruleInput, RULES, SCAN_CANDIDATES, scanScenarios, scanSnap } from "./scenarios";
import { LEVEL_LABEL, bottomLine, RATING_METHOD, RATING_METHOD_NUMBERS, REASON, scanBottomLine, smallLinkText, STRONG_MISS_90, WARNING_RATE, type BottomLine } from "./summary";
import { fmtR } from "../research/parts";
import { EVENT, MARKET, bottomLineInput, simulated, summaryText, withParts } from "./test-helpers";
import { numbersIn } from "../report/test-helpers";
import { bottomLineSection } from "../report/bottomLineReport";

const section = (s: BottomLine, id: string) => s.sections.find((x) => x.id === id)!.items.join("\n");
const tile = (s: BottomLine, id: string) => s.tiles.find((t) => t.id === id)!;
/** A scan's words about its lead, as one text: what shows with its badge runs straight on into its folded reasons. */
const leadWords = (s: BottomLine) => {
  const lead = s.sections.find((x) => x.id === "scan-lead")!.items;
  const why = s.sections.find((x) => x.id === "scan-why")!.items;
  return [`${lead[0]} ${why[0]}`, ...why.slice(1), ...lead.slice(1)].join("\n");
};
/** A scan's counts, as one text: the finding, then the rest in its folded reasons. */
const countWords = (s: BottomLine) => {
  const why = s.sections.find((x) => x.id === "scan-why")!.items;
  return `${s.headline} ${why.at(-2)}`;
};
const summary = (name: (typeof RULES)[number], over = {}) => bottomLine(ruleInput(name, over));

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
    expect(weak.verdict).toBe("Maybe, but it’s shaky.");
    expect(weak.headline).toBe("When the chance of “Fed maintains rate” rose, TLT tended to rise slightly in the same hour, beyond what moves in SPY explain.");
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
    const s = bottomLine(bottomLineInput({ ...results, market: { ...results.market!, primary: null, kalshi: null } }, { unavailable: "TLT is the benchmark itself" }));
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
    expect(leadWords(scans["scan strong small link"])).toContain("but the link itself is small: the expected rate change’s moves explain only a tiny part of how TLT moved.");
    expect(leadWords(scans["scan moderate small link, market lead"])).toContain("but the link itself is small: Kalshi’s moves");
    for (const name of ["scan strong", "scan moderate", "scan fragile (F3)", "scan nothing stood out"]) expect(leadWords(scans[name])).not.toContain("the link itself is small");
  });
});

describe("how big", () => {
  it("rescales the regression to 10 pp for a market and 25 bp for an event, with its range", () => {
    const { results } = base();
    const fit = results.market!.kalshi!;
    for (const [variable, scale] of [[MARKET, 10], [EVENT, 25]] as const) {
      const s = bottomLine(bottomLineInput(results, { variable, leaveOneOut: base().loo }));
      const size = section(s, "size");
      expect(size).toContain(`went with about a ${formatSigned(fit.coef * scale, 2, "%")} move in TLT in the same hour.`);
      expect(size).toContain(`The likely range is ${formatSigned(fit.test.ci![0] * scale, 2, "%")} to ${formatSigned(fit.test.ci![1] * scale, 2, "%")}.`);
      expect(s.derived).toEqual(expect.arrayContaining([formatSigned(fit.coef * scale, 2, "%"), String(scale)]));
    }
    expect(section(bottomLine(bottomLineInput(results, { variable: MARKET })), "size")).toContain("Take a 10-percentage-point rise in the chance of “Fed maintains rate”, say from 40% to 50%.");
    expect(section(bottomLine(bottomLineInput(results, { variable: EVENT })), "size")).toContain("Take a 25-basis-point rise in the expected rate change, the size of one usual Fed move.");
  });

  it("says when the range includes zero, when the size points the other way, and when there's no size", () => {
    const { results } = base();
    const at = (coef: number, ci: [number, number] | null, r: number) =>
      section(bottomLine(bottomLineInput(withParts(results, { kalshi: { coef, test: { ...results.market!.kalshi!.test, ci } }, primary: { ...results.market!.primary!, estimate: r } }))), "size");
    expect(at(0.01, [-0.005, 0.02], 0.1)).toContain("The range includes zero, so the true effect could be none at all.");
    expect(at(0.01, [0.004, 0.02], 0.1)).not.toContain("includes zero");
    expect(at(0.01, [0.004, 0.02], -0.1)).toContain("points the other way from the main test");
    expect(at(0.01, null, 0.1)).toContain("The test couldn’t give a range for it.");
    expect(section(bottomLine(bottomLineInput(withParts(results, { kalshi: null }))), "size")).toBe("There’s too little data to put a size on it.");
  });
});

describe("does Kalshi move first", () => {
  const lagged = (passing: Record<number, number>) => {
    const { results } = base();
    const lags: LagCorrelation[] = results.view.lags.map((l) =>
      l.test.role === "primary" ? l : { ...l, test: { ...l.test, p: passing[l.lag] ?? 0.5, bh: passing[l.lag] ?? 0.8, holm: passing[l.lag] ?? 1 } },
    );
    return section(bottomLine(bottomLineInput({ ...results, view: { ...results.view, lags } })), "lead");
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
    expect(fragile).toContain("This result is fragile. Even with no real link, this warning comes on by chance in 22.5% of 90-day windows in tests.");
    // Each fact is said once in the folded reasons: the evidence names the checks its rule rests on.
    expect(section(summary("fragile_loo"), "evidence")).toContain("Leaving out one of the 10 trading days that mattered most changed it in 2 of 10 tries.");
    expect(fragile).not.toContain("Leaving out one");
    expect(section(summary("fragile_both"), "trust")).not.toContain("bunched");
    for (const [rate] of Object.values(WARNING_RATE)) expect(WARNING_BY_CHANCE).toContain(rate);
    expect(section(summary("fragile_loo", { resolution: "daily" }), "trust")).not.toContain("by chance in");
    expect(section(summary("no_link"), "trust")).toContain("Stable: leaving out any one of the 10 trading days that mattered most didn’t change the result.");
    expect(section(summary("strong"), "evidence")).toContain("It held up when each of the 10 trading days that mattered most was left out.");
    expect(section(summary("strong"), "trust")).not.toContain("Stable:");
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
    expect(countWords(scans["scan strong"])).toBe(
      "Out of 3 markets and events tested, 1 still looked related after correcting for testing many at once. 1 also passed the stricter check. Before correcting, 1 had a p-value under 0.05, where about 0.2 would be expected by chance alone even if none were related.",
    );
    expect(countWords(scans["scan moderate small link, market lead"])).toContain("None passed the stricter check.");
    expect(countWords(scans["scan nothing stood out"])).toMatch(/^Out of 3 markets and events tested, none still looked related after correcting for testing many at once\. Before correcting/);
    expect(scans["scan still running"].headline).toMatch(/^So far, out of 2 markets and events tested/);
    expect(scans["scan with an untested candidate"].headline).toMatch(/^Out of 2 markets and events tested/);
  });

  it("rates the strongest lead on its corrected p, with Nothing stood out when it doesn't survive", () => {
    expect(scans["scan strong"].level).toBe("strong");
    expect(leadWords(scans["scan strong"])).toContain(
      "The strongest lead is “Fed decision in Dec 2025” (KXFEDDECISION-25DEC). When the expected rate change rose, TLT tended to fall somewhat in the same hour, beyond what moves in SPY explain. Its correlation: r = −0.21 (95% range −0.30 to −0.12). It survives the correction with a corrected p-value under 0.005.",
    );
    expect(scans["scan moderate"].level).toBe("moderate");
    expect(scans["scan moderate, daily past 90 days"].level).toBe("moderate");
    expect(leadWords(scans["scan moderate, daily past 90 days"])).toContain("It isn’t rated Strong because");
    expect(scans["scan fragile (F3)"].level).toBe("weak");
    expect(leadWords(scans["scan fragile (F3)"])).toContain("changed it in 3 of 10 tries");
    expect(scans["scan fragile (F1)"].level).toBe("weak");
    expect(scans["scan pending leave-one-out"].level).toBe("pending");
    expect(scans["scan still running"].level).toBe("pending");
    expect(scans["scan nothing stood out"].level).toBe("nothing_stood_out");
    expect(LEVEL_LABEL.nothing_stood_out).toBe("Nothing stood out");
    expect(leadWords(scans["scan nothing stood out"])).toContain(
      "It didn’t survive the correction for testing many at once. A scan doesn’t check how big a link each one’s data could find; its own page does. On its own page it may look stronger, because that page doesn’t correct for the other 2 tests.",
    );
    expect(leadWords(scans["scan nothing stood out, two tested"])).toContain("because that page doesn’t correct for the other test.");
    expect(scans["scan nothing stood out, one tested"].level).toBe("nothing_stood_out");
    expect(leadWords(scans["scan nothing stood out, one tested"])).not.toContain("On its own page");
    expect(scans["scan not enough data (F1)"].level).toBe("not_enough_data");
    // Its folded reasons open on their own, after the lead shown above them.
    expect(section(scans["scan not enough data (F1)"], "scan-why")).toMatch(/^The expected rate change’s movement was bunched into a few hours, so a real link could easily be missed\./);
    for (const s of Object.values(scans).filter((s) => s.sections.some((x) => x.id === "scan-lead"))) {
      expect(leadWords(s)).toContain("Leads at the top of a scan are probably overstated, because they rank first partly by luck.");
    }
  });

  it("says when nothing could be tested, or nothing has finished", () => {
    expect(scans["scan nothing tested"].headline).toBe("None of the candidates could be tested.");
    expect(scans["scan just started"].headline).toBe("Results appear here as each candidate finishes.");
    expect(scanBottomLine({ ...settings, snap: scanSnap({ bh: 0.02, holm: 0.03 }) }).level).toBe("moderate");
  });
});

describe("the question and the answer", () => {
  it("asks what the inputs ask, in chance and not in odds", () => {
    expect(summary("strong").question).toBe("Did TLT move with the chance of “Fed maintains rate”?");
    expect(summary("strong", { variable: EVENT }).question).toBe("Did TLT move with the expected rate change?");
    expect(summary("strong", { stock: "NVDA" }).question).toBe("Did NVDA move with the chance of “Fed maintains rate”?");
  });

  it("starts each answer with its level's fixed verdict", () => {
    const verdicts: [(typeof RULES)[number], string, string][] = [
      ["strong", "strong", "Yes, in this window."],
      ["strong_small", "strong", "Yes, but the link is small."],
      ["moderate", "moderate", "Probably, in this window."],
      ["moderate_small", "moderate", "Probably, but the link is small."],
      ["fragile_loo", "weak", "Maybe, but it’s shaky."],
      ["fragile_both", "weak", "Maybe, but it’s shaky."],
      ["no_interval", "weak", "Maybe, but it’s shaky."],
      ["no_link", "no_clear_link", "Not clearly."],
      ["no_p", "not_enough_data", "Can’t tell yet."],
      ["few_moves", "not_enough_data", "Can’t tell yet."],
      ["low_power", "not_enough_data", "Can’t tell yet."],
      ["pending_significant", "pending", "Still checking."],
    ];
    for (const [name, level, verdict] of verdicts) {
      const s = summary(name);
      expect(s.level, name).toBe(level);
      expect(s.verdict, name).toBe(verdict);
    }
    const { results } = base();
    expect(bottomLine(bottomLineInput({ ...results, market: { ...results.market!, primary: null, kalshi: null } })).verdict).toBe("Can’t say here.");
  });

  it("keeps a verdict's size claim to the small-link note: no verdict says how big, except that the link is small", () => {
    for (const { summary: s } of analysisScenarios()) {
      expect(s.verdict.includes("small"), `${s.level} ${s.verdict}`).toBe(section(s, "evidence").includes("the link itself is small"));
    }
  });

  it("names the level in the folded reasons' title, the first thing it opens to", () => {
    expect(summary("fragile_loo").why).toBe("Why it’s rated Weak");
    expect(summary("no_link").why).toBe("Why it’s rated No clear link");
    expect(summary("no_p").why).toBe("Why it’s rated Not enough data");
    expect(summary("pending_significant").why).toBe("What’s still being checked");
    const { results } = base();
    expect(bottomLine(bottomLineInput({ ...results, market: { ...results.market!, primary: null, kalshi: null } })).why).toBe("Why there’s no rating");
    expect(summary("strong").sections.find((x) => x.id === "evidence")!.title).toBe("Why it’s rated Strong");
  });
});

describe("the tiles", () => {
  it("come in the same three, in the same order, for every analysis", () => {
    for (const { summary: s, name } of analysisScenarios()) expect(s.tiles.map((t) => t.id), name).toEqual(["sure", "big", "first"]);
    expect(summary("strong").tiles.map((t) => t.label)).toEqual(["How sure?", "How big?", "Does Kalshi move first?"]);
    expect(summary("strong", { variable: EVENT }).tiles.map((t) => t.label)).toEqual(["How sure?", "How big?", "Does Kalshi move first?"]);
  });

  it("How sure? gives the level and a reason of two to four words", () => {
    for (const reason of Object.values(REASON)) expect(reason.split(" ").length, reason).toBeGreaterThanOrEqual(2);
    for (const reason of Object.values(REASON)) expect(reason.split(" ").length, reason).toBeLessThanOrEqual(4);
    for (const { summary: s, name } of analysisScenarios()) {
      expect(tile(s, "sure").value, name).toBe(LEVEL_LABEL[s.level]);
      expect(Object.values(REASON), name).toContain(tile(s, "sure").note);
    }
    expect(tile(summary("fragile_loo"), "sure").note).toBe("Fragile result");
    expect(tile(summary("no_link"), "sure").note).toBe("Strong link unlikely");
    expect(tile(summary("few_moves"), "sure").note).toBe("Too few moves");
    expect(tile(summary("no_p"), "sure").note).toBe("Main test can’t run");
  });

  it("How big? is the size as one number, for 10 points of chance or 25 bp", () => {
    const { results } = base();
    const fit = results.market!.kalshi!;
    const market = tile(bottomLine(bottomLineInput(results, { variable: MARKET, leaveOneOut: base().loo })), "big");
    expect(market.value).toBe(formatSigned(fit.coef * 10, 2, "%"));
    expect(market.note).toContain("TLT’s move per 10-point rise in the chance.");
    const event = tile(bottomLine(bottomLineInput(results, { variable: EVENT, leaveOneOut: base().loo })), "big");
    expect(event.value).toBe(formatSigned(fit.coef * 25, 2, "%"));
    expect(event.note).toContain("TLT’s move per 25 bp rise.");
  });

  it("How big? says it could be zero exactly when the range includes zero, or there's no range", () => {
    const { results } = base();
    const at = (coef: number, ci: [number, number] | null, r = 0.1) =>
      tile(bottomLine(bottomLineInput(withParts(results, { kalshi: { coef, test: { ...results.market!.kalshi!.test, ci } }, primary: { ...results.market!.primary!, estimate: r } }))), "big");
    expect(at(0.01, [-0.005, 0.02]).note).toBe("TLT’s move per 10-point rise in the chance. Could be zero: range −0.05% to +0.20%.");
    expect(at(0.01, [0, 0.02]).note).toContain("Could be zero");
    expect(at(0.01, [0.004, 0.02]).note).toBe("TLT’s move per 10-point rise in the chance. Range +0.04% to +0.20%.");
    expect(at(-0.01, [-0.02, -0.004], -0.1).note).toBe("TLT’s move per 10-point rise in the chance. Range −0.20% to −0.04%.");
    expect(at(0.01, null).note).toBe("TLT’s move per 10-point rise in the chance. No range, so it could be zero.");
    expect(at(0.01, [0.004, 0.02], -0.1).note).toContain("Direction unclear.");
    expect(at(0.01, [0.004, 0.02]).note).not.toContain("Direction unclear.");
    const none = tile(bottomLine(bottomLineInput(withParts(results, { kalshi: null }))), "big");
    expect([none.value, none.note]).toEqual(["Unknown", "Too little data."]);
    for (const { summary: s, input, name } of analysisScenarios()) {
      const ci = input?.results.market?.kalshi?.test.ci;
      if (input?.results.market?.kalshi) expect(tile(s, "big").note.includes("could be zero") || tile(s, "big").note.includes("Could be zero"), name).toBe(!ci || (ci[0] <= 0 && ci[1] >= 0));
    }
  });

  it("Does Kalshi move first? gives one of four answers, from the corrected lags", () => {
    const { results } = base();
    const lagged = (passing: Record<number, number>, base2 = results) => {
      const lags: LagCorrelation[] = base2.view.lags.map((l) =>
        l.test.role === "primary" ? l : { ...l, test: { ...l.test, p: passing[l.lag] ?? 0.5, bh: passing[l.lag] ?? 0.8, holm: passing[l.lag] ?? 1 } },
      );
      return tile(bottomLine(bottomLineInput({ ...base2, view: { ...base2.view, lags } })), "first");
    };
    const read = (t: { value: string; note: string }) => [t.value, t.note];
    expect(read(lagged({}))).toEqual(["No", "No clear sign after correcting for checking 6 time shifts."]);
    expect(read(lagged({ 2: 0.001 }))).toEqual(["Kalshi first", "Maybe: TLT moved 2 hours later. A lead to check."]);
    expect(read(lagged({ [-1]: 0.001 }))).toEqual(["Stock first", "Maybe: Kalshi moved 1 hour later. A lead to check."]);
    expect(read(lagged({ 1: 0.001, [-3]: 0.002 }))).toEqual(["Can’t tell", "Time shifts passed both ways."]);
    const none = results.view.lags.map((l) => (l.test.role === "primary" ? l : { ...l, test: { ...l.test, p: null } }));
    expect(read(tile(bottomLine(bottomLineInput({ ...results, view: { ...results.view, lags: none } })), "first"))).toEqual(["Can’t tell", "Too little data to check."]);
    const raw = analysisScenarios().find((s) => s.name === "market raw returns")!.summary;
    expect(tile(raw, "first").note).toMatch(/Uses raw returns\.$/);
  });

  it("are the counts for a scan, with the chance figure beside the uncorrected count", () => {
    const scans = Object.fromEntries(scanScenarios().map((s) => [s.name, s.summary]));
    const read = (s: BottomLine) => s.tiles.map((t) => [t.label, t.value, t.note]);
    expect(read(scans["scan strong"])).toEqual([
      ["Tested", "3", "markets and events"],
      ["Still related after correcting", "1", "1 also passed the stricter check."],
      ["Expected by chance before correcting", "About 0.2", "1 had a p-value under 0.05 before correcting."],
    ]);
    expect(tile(scans["scan moderate small link, market lead"], "related").note).toBe("None passed the stricter check.");
    expect(tile(scans["scan nothing stood out"], "related")).toMatchObject({ value: "0", note: "The less strict check found none." });
    expect(tile(scans["scan with an untested candidate"], "tested")).toMatchObject({ value: "2", note: "markets and events; 1 couldn’t be tested" });
    expect(tile(scans["scan still running"], "tested").note).toContain("so far");
    expect(scans["scan nothing tested"].tiles).toEqual([]);
    expect(scans["scan just started"].tiles).toEqual([]);
  });
});

describe("a scan's question and verdict", () => {
  const scans = Object.fromEntries(scanScenarios().map((s) => [s.name, s.summary]));
  const settings = { stock: "TLT", choice: 90 as const, resolution: "hourly" as const };

  it("asks about every candidate in the list", () => {
    expect(scans["scan strong"].question).toBe("Did any of these 3 markets and events move with TLT?");
    const snap = scanSnap({ bh: 0.02, holm: 0.03 });
    const events = SCAN_CANDIDATES.map((c) => ({ ...c, kind: "event" as const }));
    expect(scanBottomLine({ ...settings, candidates: events, snap }).question).toBe("Did any of these 3 events move with TLT?");
    const one = { ...snap, states: snap.states.slice(0, 1), corrections: snap.corrections.slice(0, 1), order: [0] };
    expect(scanBottomLine({ ...settings, candidates: events.slice(0, 1), snap: one }).question).toBe("Did this event move with TLT?");
  });

  it("starts each answer with its level's fixed verdict, as a lead to check", () => {
    const verdicts: [string, string][] = [
      ["scan strong", "Yes, as a lead to check."],
      ["scan strong small link", "Yes, but the link is small."],
      ["scan moderate", "Probably, as a lead to check."],
      ["scan moderate small link, market lead", "Probably, but the link is small."],
      ["scan fragile (F3)", "Maybe, but the lead is shaky."],
      ["scan no interval", "Maybe, but the lead is shaky."],
      ["scan nothing stood out", "Nothing stood out."],
      ["scan not enough data (F1)", "Can’t tell yet."],
      ["scan pending leave-one-out", "Still checking."],
      ["scan just started", "Still checking."],
      ["scan nothing tested", "Can’t say here."],
    ];
    for (const [name, verdict] of verdicts) expect(scans[name].verdict, name).toBe(verdict);
  });

  it("shows the lead and the caution, and folds the rest away", () => {
    const s = scans["scan strong"];
    expect(section(s, "scan-lead")).toBe(
      "The strongest lead is “Fed decision in Dec 2025” (KXFEDDECISION-25DEC). When the expected rate change rose, TLT tended to fall somewhat in the same hour, beyond what moves in SPY explain.\nLeads at the top of a scan are probably overstated, because they rank first partly by luck. Expect a smaller link if one is checked again on new data.",
    );
    expect(s.sections.find((x) => x.id === "scan-why")!.title).toBe(s.why);
    expect(section(s, "scan-why")).toContain("Its correlation: r = −0.21");
    expect(section(s, "scan-why")).toContain("Open its full analysis for the details.");
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

describe("a 180-day window", () => {
  // The page computes 180D, 1Y, and All only after an effect loads their rows, so accuracy.test.tsx can't
  // render them. This summarizes a 124-session window's own results, computed as the panel computes them.
  const { results, loo } = simulated({ window: 124, effect: 0.3 });
  const primary = results.market!.primary!;
  const s = bottomLine(bottomLineInput(results, { choice: 180, leaveOneOut: loo, detectable: null }));

  it("rates it and quotes its own numbers", () => {
    expect(primary.resampling?.units).toBe(124);
    expect(primary.p).toBeLessThan(0.05);
    expect(["weak", "moderate", "strong"]).toContain(s.level);
    expect(section(s, "evidence")).toContain(`Main test: correlation r = ${fmtR(primary.estimate)}`);
    expect(section(s, "trust")).toContain(
      `Based on ${results.fragility!.movement.intervals.toLocaleString("en-US")} trading hours in a 180-day window; Kalshi moved in ${results.fragility!.movement.moves.toLocaleString("en-US")} of them, across 124 trading days.`,
    );
  });

  it("says nothing about settings that weren't simulated, since 180 days hourly was", () => {
    expect(summaryText(s)).not.toContain("wasn’t simulated");
    expect(summaryText(s)).not.toContain("rated Strong 1.8%");
  });
});

describe("the tiles in a report", () => {
  it("read as one line each, a question's label running straight on", () => {
    const lines = (s: BottomLine) => {
      const block = bottomLineSection(s, { method: false }).blocks.find((b) => b.kind === "list")!;
      return block.kind === "list" ? block.items : [];
    };
    expect(lines(summary("fragile_loo"))[0]).toBe("How sure? Weak. Fragile result.");
    const scans = Object.fromEntries(scanScenarios().map((s) => [s.name, s.summary]));
    expect(lines(scans["scan strong"])).toEqual([
      "Tested: 3 markets and events.",
      "Still related after correcting: 1. 1 also passed the stricter check.",
      "Expected by chance before correcting: About 0.2. 1 had a p-value under 0.05 before correcting.",
    ]);
  });
});
