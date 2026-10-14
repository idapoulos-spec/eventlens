import { describe, expect, it } from "vitest";
import { mapEvent, mapOutcome, type OutcomeContract } from "./mapping";
import { supportedEvent } from "./series";

const MONTHS = "October 2026";

/** A Fed outcome as Kalshi words it today, with fields overridden. */
function contract(suffix: string, strike: Record<string, string> | null, label: string, more: Partial<OutcomeContract> = {}): OutcomeContract {
  const [word, amount] = Object.entries(strike ?? { Hike: "0" })[0];
  return {
    ticker: `KXFEDDECISION-26OCT-${suffix}`,
    event_ticker: "KXFEDDECISION-26OCT",
    custom_strike: strike,
    yes_sub_title: label,
    title: `Will the Federal Reserve ${word} rates by ${amount}bps at their ${MONTHS} meeting?`,
    rules_primary: `If the Federal Reserve does a ${word} of ${amount}bps on October 28, 2026, then the market resolves to Yes.`,
    ...more,
  };
}

const value = (c: OutcomeContract) => {
  const r = mapOutcome(c);
  return r.ok ? [r.outcome.value, r.outcome.suffix, r.outcome.mappedBy] : [null, r.outcome.reason];
};

describe("supportedEvent", () => {
  it("accepts Fed decision event tickers, current and legacy, but not markets or other series", () => {
    for (const t of ["KXFEDDECISION-26OCT", "FEDDECISION-23MAY", "FEDDECISION-24JAN31", "FEDDECISION-24MAR20"]) {
      expect(supportedEvent(t)?.series).toBe("KXFEDDECISION");
    }
    for (const t of ["KXFEDDECISION-26OCT-H25", "KXFEDDECISION", "KXFED-26DEC", "KXFEDDECISION-26OCTX", "XKXFEDDECISION-26OCT"]) {
      expect(supportedEvent(t)).toBeNull();
    }
  });
});

describe("mapOutcome", () => {
  it("maps today's suffixes: cuts negative, hikes positive, '>X' at the next 25 bp step", () => {
    expect(value(contract("C25", { Cut: "25" }, "Cut 25bps"))).toEqual([-25, "agrees", "strike_and_label"]);
    expect(value(contract("C26", { Cut: ">25" }, "Cut >25bps"))).toEqual([-50, "agrees", "strike_and_label"]);
    expect(value(contract("H0", { Hike: "0" }, "Fed maintains rate"))).toEqual([0, "agrees", "strike_and_label"]);
    expect(value(contract("H25", { Hike: "25" }, "Hike 25bps"))).toEqual([25, "agrees", "strike_and_label"]);
    expect(value(contract("H26", { Hike: ">25" }, "Hike >25bps"))).toEqual([50, "agrees", "strike_and_label"]);
  });

  it("maps the legacy suffixes, flagging the irregular ones without letting them decide", () => {
    const legacy = (ticker: string, strike: Record<string, string>, label: string, title: string) =>
      value({ ticker, event_ticker: ticker.split("-").slice(0, 2).join("-"), custom_strike: strike, yes_sub_title: label, title, rules_primary: null });
    expect(legacy("FEDDECISION-23JUL-C>25", { Cut: ">25" }, "Cut >25bps", "Will the Federal Reserve Cut rates by >25bps at their July 2023 meeting?")).toEqual([-50, "agrees", "strike_and_label"]);
    expect(legacy("FEDDECISION-23JUL-H>25", { Hike: ">25" }, "Hike >25bps", "Will the Federal Reserve Hike rates by >25bps at their July 2023 meeting?")).toEqual([50, "agrees", "strike_and_label"]);
    expect(legacy("FEDDECISION-23DEC-C24", { Cut: ">25" }, "Cut >25bps", "Will the Federal Reserve Cut rates by >25bps at their December 2023 meeting?")).toEqual([-50, "irregular", "strike_and_label"]);
    expect(legacy("FEDDECISION-23MAY-TC25", { Cut: ">25" }, "Cut >25bps", "Will the Federal Reserve Cut rates by >25bps at their May 2023 meeting?")).toEqual([-50, "irregular", "strike_and_label"]);
    // "by >50" without "bps", and a strike with it.
    expect(legacy("FEDDECISION-23MAY-TH50", { Hike: ">50bps" }, "Hike >50bps", "Will the Federal Reserve Hike rates by >50 at their May 2023 meeting?")).toEqual([75, "irregular", "strike_and_label"]);
    expect(legacy("FEDDECISION-23MAY-H50", { Hike: "50" }, "Hike 50bps", "Will the Federal Reserve Hike rates by 50 at their May 2023 meeting?")).toEqual([50, "agrees", "strike_and_label"]);
  });

  it("maps every hold label to 0", () => {
    for (const label of ["No change", "Hike 0bps", "No cut/hike", "Fed maintains rate"]) {
      expect(value(contract("H0", { Hike: "0" }, label))).toEqual([0, "agrees", "strike_and_label"]);
    }
  });

  it("accepts live rules text that drops the '>' of an open-ended outcome", () => {
    const c = contract("C26", { Cut: ">25" }, "Cut >25bps", {
      rules_primary: "If the Federal Reserve does a Cut of   25bps on October 28, 2026, then the market resolves to Yes.",
    });
    expect(value(c)).toEqual([-50, "agrees", "strike_and_label"]);
  });

  it("refuses sources that disagree", () => {
    expect(value(contract("C25", { Cut: "25" }, "Cut >25bps"))).toEqual([null, "strike_disagrees"]);
    expect(value(contract("C25", { Hike: "25" }, "Cut 25bps"))).toEqual([null, "strike_disagrees"]);
    expect(value(contract("C25", { Cut: "25" }, "Cut 25bps", { title: "Will the Federal Reserve Cut rates by 50bps at their October 2026 meeting?" }))).toEqual([
      null,
      "title_contradicts",
    ]);
    expect(value(contract("C25", { Cut: "25" }, "Cut 25bps", { rules_primary: "If the Federal Reserve does a Hike of 25bps, then the market resolves to Yes." }))).toEqual([
      null,
      "rules_contradict",
    ]);
    // A ">" the rules do state must match.
    expect(value(contract("C25", { Cut: "25" }, "Cut 25bps", { rules_primary: "If the Federal Reserve does a Cut of >25bps, then the market resolves to Yes." }))).toEqual([
      null,
      "rules_contradict",
    ]);
    expect(value(contract("X", { Cut: "25" }, "Cut a lot"))).toEqual([null, "label_unreadable"]);
    expect(value(contract("C25", { Cut: "some" }, "Cut 25bps"))).toEqual([null, "strike_unreadable"]);
    expect(value(contract("C25", { Cut: "25", Hike: "0" }, "Cut 25bps"))).toEqual([null, "strike_unreadable"]);
  });

  it("without custom_strike, needs the title and the rules to confirm the label (KXFEDDECISION-25JAN-H0)", () => {
    const h0 = {
      ticker: "KXFEDDECISION-25JAN-H0",
      event_ticker: "KXFEDDECISION-25JAN",
      yes_sub_title: "No change",
      title: "Will the Federal Reserve Hike rates by 0bps at their January 2025 meeting?",
      rules_primary: "If the Federal Reserve does a Hike of 0bps on January 29, 2025, then the market resolves to Yes.",
    };
    expect(value(h0)).toEqual([0, "agrees", "label_title_rules"]);
    expect(value({ ...h0, custom_strike: null })).toEqual([0, "agrees", "label_title_rules"]);
    expect(value({ ...h0, rules_primary: undefined })).toEqual([null, "unconfirmed_without_strike"]);
    expect(value({ ...h0, title: "Fed decision in January 2025?" })).toEqual([null, "unconfirmed_without_strike"]);
    // The title must say "more than" exactly when the label does: rules alone can't.
    const c26 = contract("C26", null, "Cut >25bps", {
      title: "Will the Federal Reserve Cut rates by 25bps at their October 2026 meeting?",
      rules_primary: "If the Federal Reserve does a Cut of   25bps, then the market resolves to Yes.",
    });
    expect(value(c26)).toEqual([null, "unconfirmed_without_strike"]);
  });
});

describe("mapEvent", () => {
  const fed = [
    contract("C26", { Cut: ">25" }, "Cut >25bps"),
    contract("C25", { Cut: "25" }, "Cut 25bps"),
    contract("H0", { Hike: "0" }, "Fed maintains rate"),
    contract("H25", { Hike: "25" }, "Hike 25bps"),
    contract("H26", { Hike: ">25" }, "Hike >25bps"),
  ];

  it("maps every outcome of an exclusive event", () => {
    const m = mapEvent(fed, true);
    expect(m.problem).toBeNull();
    expect(m.unmapped).toEqual([]);
    expect(m.outcomes.map((o) => o.value)).toEqual([-50, -25, 0, 25, 50]);
  });

  it("gives no outcomes when one can't be mapped, naming it", () => {
    const m = mapEvent([...fed.slice(0, 4), contract("H26", { Hike: ">25" }, "Hike lots")], true);
    expect(m.outcomes).toEqual([]);
    expect(m.unmapped).toEqual([{ ticker: "KXFEDDECISION-26OCT-H26", label: "Hike lots", reason: "label_unreadable" }]);
  });

  it("refuses two outcomes worth the same", () => {
    // "Hike 50bps" and "Hike >25bps" are both 50 bp.
    const m = mapEvent([...fed, contract("H50", { Hike: "50" }, "Hike 50bps")], true);
    expect(m.outcomes).toEqual([]);
    expect(m.unmapped.map((u) => [u.ticker, u.reason])).toEqual([
      ["KXFEDDECISION-26OCT-H26", "duplicate_value"],
      ["KXFEDDECISION-26OCT-H50", "duplicate_value"],
    ]);
  });

  it("refuses an event whose outcomes don't exclude each other, or that has none", () => {
    expect(mapEvent(fed, false)).toEqual({ outcomes: [], unmapped: [], problem: "not_exclusive" });
    expect(mapEvent([], true)).toEqual({ outcomes: [], unmapped: [], problem: "no_outcomes" });
    // Unknown (a stored event without its event object) isn't a refusal.
    expect(mapEvent(fed, null).outcomes).toHaveLength(5);
  });
});
