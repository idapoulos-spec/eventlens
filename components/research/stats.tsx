// How every test result on the Research section is shown: the same numbers, wording, and
// table columns, whichever analysis produced it.

import type { ReactNode } from "react";
import { ALPHA, MIN_BOOTSTRAP_BLOCKS, MIN_TEST_EVENTS, passes, type EventStudyTests, type TestResult } from "@/lib/analytics";
import { plural } from "./parts";

/** e.g. "0.034", "< 0.001", or "—". */
export function formatP(p: number | null): string {
  if (p === null) return "—";
  return p < 0.001 ? "< 0.001" : p.toFixed(3);
}

/** A smallest-possible p-value, e.g. "0.001" or "0.0625". */
export const formatMinP = (p: number) => (p >= 0.001 ? String(Number(p.toPrecision(3))) : p.toExponential(1));

export function formatCi(ci: [number, number] | null, format: (v: number) => string): string {
  return ci === null ? "—" : `${format(ci[0])} to ${format(ci[1])}`;
}

/** "Holm and BH", "BH only", or "—" for exploratory results; judged on its own p for the primary test. */
export function passText(test: TestResult): string {
  if (test.role === "primary") return test.p === null ? "—" : passes(test, "raw") ? "Yes (primary, uncorrected)" : "No";
  if (passes(test, "holm")) return "Holm and BH";
  return passes(test, "bh") ? "BH only" : "—";
}

/** e.g. "118 (≈ 96 effective)". */
export function formatN(test: TestResult): string {
  const eff = test.nEffective === null ? null : Math.round(test.nEffective);
  return eff !== null && eff < test.n ? `${test.n} (≈ ${eff} eff.)` : String(test.n);
}

const unitNouns = (test: TestResult): [string, string] =>
  test.resampling?.unit === "day_run"
    ? [`run of ${test.resampling.runDays} trading days`, `runs of ${test.resampling.runDays} trading days`]
    : test.resampling?.unit === "event"
      ? ["event", "events"]
      : ["session", "sessions"];

/** How the p-value and interval were computed, in one sentence. */
export function methodText(test: TestResult): string {
  const r = test.resampling;
  switch (test.method) {
    case "wild_bootstrap": {
      if (!r || r.draws === 0) return "Wild bootstrap.";
      const per = r.unit === "day_run" ? `run of ${r.runDays} trading days` : "session";
      const count = plural(r.units, r.unit === "day_run" ? ["run", "runs"] : ["session", "sessions"]);
      const refit =
        r.refit === "market_model"
          ? " Alpha and beta are refitted on the full 90 days in every draw (each of its sessions weighted too), so the uncertainty in beta is included."
          : r.refit === "regression"
            ? " Every coefficient, the benchmark’s included, is refitted in every draw."
            : "";
      return `Wild bootstrap with one random weight per ${per} (${count}, ${r.draws.toLocaleString("en-US")} draws), so the smallest possible p is ${formatMinP(r.minP)}. The interval holds every value the same test wouldn’t reject.${refit}`;
    }
    case "sign_flip":
      return r && r.draws > 0
        ? `Sign-flip test over ${plural(r.units, ["event", "events"])} (${
            r.draws === 2 ** r.units ? `all ${r.draws.toLocaleString("en-US")} sign patterns, exact` : `${r.draws.toLocaleString("en-US")} random sign patterns`
          }), so the smallest possible p is ${formatMinP(r.minP)}; bootstrap-t interval over events.`
        : "Sign-flip test over events.";
  }
}

/** Why a p-value isn't shown, or null when it is. */
export function unavailableText(test: TestResult): string | null {
  const r = test.resampling;
  switch (test.pUnavailable) {
    case null:
      return null;
    case "too_few_blocks":
      return `Only ${plural(r?.units ?? 0, unitNouns(test))} in this window: too few for the wild bootstrap to be reliable (it needs at least ${MIN_BOOTSTRAP_BLOCKS}), so no p-value or interval is shown.`;
    case "too_few_events":
      return `Only ${plural(test.n, ["event", "events"])}: too few for intervals or p-values to mean much (at least ${MIN_TEST_EVENTS} needed).`;
    case "too_few_pairs":
      return "Fewer than 10 matching intervals.";
    case "no_variation":
      return "One series didn’t vary, so there’s nothing to test.";
    case "unstable":
      return "A single interval decides the estimate, so its uncertainty can’t be estimated.";
  }
}

/**
 * How the event study's tests are corrected, naming only the directions that were tested (a
 * test that couldn't run doesn't count toward its family), e.g. "The 24 tested bars (12 after
 * rises, 12 after falls) are corrected together as one family, and the two whole-path tests as another."
 */
export function eventFamilyText(tests: EventStudyTests): string {
  const groups = [
    { name: "rises", group: tests.rises },
    { name: "falls", group: tests.falls },
  ].map((g) => ({ ...g, bars: g.group.bars.filter((t) => t !== null && t.p !== null).length }));
  const tooFew = (g: (typeof groups)[number]) => g.group.path.pUnavailable === "too_few_events";
  const tested = groups.filter((g) => g.bars > 0);
  const untested = groups.filter((g) => g.bars === 0);

  if (tested.length === 2) {
    const [rises, falls] = tested;
    return `The ${rises.bars + falls.bars} tested bars (${rises.bars} after rises, ${falls.bars} after falls) are corrected together as one family, and the two whole-path tests as another.`;
  }
  if (tested.length === 1) {
    const [only] = tested;
    const [other] = untested;
    const why = tooFew(other) ? ` (there were fewer than ${MIN_TEST_EVENTS} ${other.name})` : "";
    return `Only ${only.name} were tested${why}. Their ${only.bars} bars are corrected as one family; with no whole-path test for ${other.name}, the one for ${only.name} needs no correction.`;
  }
  return groups.every(tooFew)
    ? `No bars were tested because there were too few jumps: a test needs at least ${MIN_TEST_EVENTS} rises or ${MIN_TEST_EVENTS} falls.`
    : "No bars could be tested.";
}

export function RoleBadge({ role }: { role: TestResult["role"] }) {
  return (
    <span className="inline-flex items-center rounded border border-border px-1.5 py-0.5 text-[0.65rem] font-semibold uppercase tracking-wider text-ink-secondary">
      {role === "primary" ? "Primary test" : "Exploratory"}
    </span>
  );
}

/** One result in a sentence: "r = +0.12 (95% CI −0.03 to +0.26), p = 0.110, n = 118 (≈ 96 eff.)". */
export function ResultLine({ test, label, format }: { test: TestResult; label: string; format: (v: number) => string }) {
  return (
    <span className="tabular-nums">
      {label} = <span className="font-semibold text-ink">{test.estimate === null ? "—" : format(test.estimate)}</span>
      {test.ci && ` (95% CI ${formatCi(test.ci, format)})`}
      {test.p !== null && (
        <>
          , p = <span className="font-semibold text-ink">{formatP(test.p)}</span>
        </>
      )}
      , n = {formatN(test)}
    </span>
  );
}

/** The standard columns for a list of results. */
export const TEST_COLUMNS = ["Estimate", "95% CI", "p", "Holm", "BH", "Passes", "n"];

export function testCells(test: TestResult | null, format: (v: number) => string): string[] {
  if (test === null) return ["—", "—", "—", "—", "—", "—", "—"];
  return [
    test.estimate === null ? "—" : format(test.estimate),
    formatCi(test.ci, format),
    formatP(test.p),
    formatP(test.holm),
    formatP(test.bh),
    passText(test),
    formatN(test),
  ];
}

/** A short verdict for one test: whether it's distinguishable from zero at 5%. */
export function verdict(test: TestResult, by: "raw" | "holm" | "bh"): ReactNode {
  if (test.p === null) return null;
  return passes(test, by) ? (
    <>distinguishable from zero at the {ALPHA * 100}% level</>
  ) : (
    <>not distinguishable from zero at the {ALPHA * 100}% level</>
  );
}
