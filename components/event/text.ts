// Words for an event analysis, shared by its panel, charts, and Research.

import { EVENT_PROBLEM_TEXT, UNMAPPED_TEXT } from "@/lib/expected/mapping";
import type { CurrentRule, EventAnalysis, ExpectedNow } from "@/lib/expected/types";
import { formatSigned } from "@/lib/format";

/** E in its unit with a sign, e.g. "−12.3 bp". */
export const formatExpected = (value: number | null, unit: string, digits = 1) => formatSigned(value, digits, ` ${unit}`);

export const MISSING_TEXT: Record<NonNullable<ExpectedNow["missing"]>, string> = {
  after_close: "the first outcome has closed",
  not_open: "no outcome was open",
  sum_out_of_range: "the open outcomes’ probabilities summed outside 0.80–1.20",
  coverage: "the collected history has a gap there",
  stale_quote: "an outcome had no usable quote for 7 days and was last above 5¢",
  history_incomplete: "an outcome had no usable quote in the loaded history, and what came before it wasn’t loaded",
  unmapped: "not every outcome could be given a value",
};

export const RULE_TEXT: Record<CurrentRule, string> = {
  1: "midpoint",
  2: "half the ask (no bid)",
  3: "halfway from bid to $1 (no ask)",
  "4_zero": "no quote: counts as 0",
  stale_quote: "no quote for 7 days, last above 5¢",
  history_incomplete: "no quote in the loaded history",
  coverage: "gap in the history",
  not_open: "not open",
};

/** The definition and rules behind E, for captions. */
export function definitionText({ unit, label }: Pick<EventAnalysis, "unit" | "label">): string {
  return (
    `E, ${label}, is Σ pᵢ·vᵢ / Σ pᵢ over the outcomes open at the time: each outcome’s value v in ${unit} (a cut is negative; ` +
    `“more than X” counts as the next 25 ${unit} step), weighted by its probability p. p is the bid/ask midpoint of the hour’s ` +
    "closing book, half the ask without a bid, or halfway from the bid to $1 without an ask; an outcome without a usable " +
    "quote in the last 7 days counts as 0 if it was last at most 5¢. E is missing, never carried over, when Σp is outside " +
    "0.80–1.20, when an outcome’s quote is stale, when the collected history has a gap, and from the first outcome’s close on."
  );
}

/** Why the event has no E at all: its problem, or each unmapped outcome and why. */
export function unmappedText(event: Pick<EventAnalysis, "problem" | "outcomes">): string | null {
  if (event.problem) return `${EVENT_PROBLEM_TEXT[event.problem]}.`;
  const unmapped = event.outcomes.filter((o) => o.unmapped !== null);
  if (unmapped.length === 0) return null;
  return `${unmapped.map((o) => `${o.ticker} (“${o.label}”): ${UNMAPPED_TEXT[o.unmapped!]}`).join("; ")}.`;
}
