// The experimental signal in words, for the bottom-line card and its report: "Leans Buy vs. SPY",
// "Leans Sell vs. SPY", or "Hold: no signal", with its evidence level, a reason, four chips, how it's
// decided, the full rules, and the disclaimer. The rules themselves are lib/analytics/signal.ts; this
// only words what that decides, from the page's own results. Pure, so the card and the report say the
// same thing. language.test.ts allows "Buy", "Sell", and "Hold" here only inside the exact labels.

import { calibrationFor, EVIDENCE, type EvidenceRating } from "@/lib/analytics/evidence";
import { FRAGILE } from "@/lib/analytics/fragility";
import { SIGNAL, signalDecision, type SignalDecision, type SignalLevel, type SignalRule } from "@/lib/analytics/signal";
import { formatSigned } from "@/lib/format";
import type { BottomLineInput } from "./summary";

/** One chip under the label: a short name and its answer. */
export interface SignalChip {
  id: "first" | "stability" | "move" | "data";
  label: string;
  value: string;
}

export interface BottomLineSignal {
  /** What it says, for the panel's looks: a lean either way, a hold, or still checking. */
  label: SignalDecision["label"];
  /** The README's rule that decided it (S1–S10). */
  rule: SignalRule;
  /** The label as written: "Leans Buy vs. SPY", "Leans Sell vs. SPY", "Hold: no signal", or "Checking…". */
  text: string;
  level: SignalLevel;
  /** The level as written beside the label: "Moderate evidence", "No clear lead", …; empty while checking. */
  levelText: string;
  /** Why it holds, or what a lean means here. */
  reason: string;
  chips: SignalChip[];
  /** "How it's decided", in one sentence. */
  decided: string;
  /** The full rules, folded away, with how they did in simulation. */
  rules: string[];
  disclaimer: string;
}

export const SIGNAL_TITLE = "Experimental signal";
export const SIGNAL_RULES_TITLE = "The full rules";
export const DECIDED_LABEL = "How it’s decided:";

/** Said once, at the end of the panel, and in a report. */
export const SIGNAL_DISCLAIMER = "Experimental signal based on past patterns. Not financial advice; markets can move for reasons this tool doesn’t measure.";

/** The one sentence a scan says about the signal: it has none. */
export const SCAN_NO_SIGNAL = "A scan has no experimental signal: it runs so many tests at once that a lead could just be luck.";

export const HOLD = "Hold: no signal";
export const leanLabel = (direction: "buy" | "sell", benchmark: string) => `Leans ${direction === "buy" ? "Buy" : "Sell"} vs. ${benchmark}`;

export const DECIDED = "Kalshi must move first in a stable, corrected test rated Moderate or better, and have just moved by the jump size.";

const LEVEL_TEXT: Record<SignalLevel, string> = {
  strong: "Strong evidence",
  moderate: "Moderate evidence",
  weak: "Weak evidence",
  no_clear_link: "No clear link",
  not_enough_data: "Not enough data",
  no_clear_lead: "No clear lead",
  none: "No rating",
  pending: "",
};

/** The card's badge words, for "the rating above". */
const BADGE_WORDS: Partial<Record<EvidenceRating["level"], string>> = {
  weak: "Weak",
  no_clear_link: "No clear link",
  not_enough_data: "Not enough data",
};

const upper = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
/** "a 2-hour lead", "a 1-day lead". */
const leadSpan = (k: number, hourly: boolean) => `a ${k}-${hourly ? "hour" : "day"} lead`;
const count = (n: number, [one, many]: [string, string]) => `${n.toLocaleString("en-US")} ${n === 1 ? one : many}`;

/** The units of time and of Kalshi's move, in sentences and on a chip. */
function units(i: BottomLineInput) {
  const hourly = i.resolution === "hourly";
  const market = i.variable.kind === "probability";
  return {
    time: (hourly ? ["hour", "hours"] : ["trading day", "trading days"]) as [string, string],
    short: (hourly ? ["hr", "hrs"] : ["day", "days"]) as [string, string],
    move: market ? (["point", "points"] as [string, string]) : ([i.variable.unit, i.variable.unit] as [string, string]),
    moveShort: market ? "pts" : i.variable.unit,
    who: market ? "Kalshi" : "the expected rate change",
    blocks: (hourly ? ["trading day", "trading days"] : ["run of trading days", "runs of trading days"]) as [string, string],
  };
}

/**
 * How the rules did in simulation, from signal-rates.sim.test.ts's single run on 2026-11-16 (README,
 * "Checking the signal by simulation"): hourly, every window ending right after a 3-point Kalshi move.
 */
export const SIGNAL_SIMULATIONS = [
  "The simulations ended each window right after a 3-point Kalshi move. With no real link, none leaned: 0 of 500 at 30, 90, and 180 days each.",
  "With a lead and a same-hour link built in, 52 of 100 leaned at 90 days, all the right way. With a lead alone, 3 of 100 did.",
];
/** The rules' numbers: the leave-one-out count, the 4 PM close, and the simulations' figures (signal.test.ts checks each against its source). */
export const SIGNAL_RULE_NUMBERS = [String(FRAGILE.leaveOut), String(SIGNAL.closeHour - 12), "3", "0", "500", "30", "90", "180", "52", "100"];

/** The signal for one analysis, from the page's own results. */
export function bottomLineSignal(i: BottomLineInput, card: EvidenceRating["level"], derived: string[]): BottomLineSignal {
  const u = units(i);
  const { results } = i;
  const decision = signalDecision({
    lags: results.shown === "adjusted" ? results.view.lags : null,
    card,
    check: i.signalCheck,
    calibration: calibrationFor(i.resolution, i.choice, i.longDaily),
    changes: results.view.changes,
    end: results.rows.length > 0 ? results.rows[results.rows.length - 1] : null,
    resolution: i.resolution,
    threshold: i.threshold,
  });
  const { lead, move, leadRating } = decision;
  const k = lead?.lag ?? 0;
  if (lead) derived.push(String(k));
  const moveText = move ? `${formatSigned(move.value, SIGNAL.moveDigits)} ${u.moveShort}` : "";
  if (move && move.slots > 0) derived.push(moveText.split(" ")[0], String(move.slots));

  const text =
    decision.label === "pending" ? "Checking…" : decision.label === "hold" ? HOLD : leanLabel(decision.label, i.benchmark);
  const reason = reasonText(i, decision, card, u, derived);

  const f = results.fragility;
  const dataCount = f && results.market?.primary?.p != null ? f.movement.intervals : results.view.changes.length;
  const chips: SignalChip[] = [
    { id: "first", label: "Kalshi moves first", value: firstValue(decision, k, u) },
    {
      id: "stability",
      label: "Stability",
      value: !lead || decision.first === "both" ? "—" : !leadRating ? "Checking…" : leadRating.rule === "fragile" ? "Fragile" : leadRating.rule === "no_interval" ? "No range" : "Stable",
    },
    {
      id: "move",
      label: `Recent ${i.variable.kind === "probability" ? "Kalshi move" : "move"}`,
      value: !lead || decision.first === "both" || !move ? "—" : move.slots === 0 ? "Too late today" : `${moveText} in ${count(move.slots, u.short)}`,
    },
    { id: "data", label: "Data", value: count(dataCount, u.short) },
  ];

  return {
    label: decision.label,
    rule: decision.rule,
    text,
    level: decision.level,
    levelText: LEVEL_TEXT[decision.level],
    reason,
    chips,
    decided: DECIDED,
    rules: rulesText(i, u),
    disclaimer: SIGNAL_DISCLAIMER,
  };
}

function firstValue(decision: SignalDecision, k: number, u: ReturnType<typeof units>): string {
  switch (decision.first) {
    case "kalshi":
      return `Yes, by ${count(k, u.short)}`;
    case "both":
      return "Both ways";
    case "stock":
      return "No, the stock does";
    case "neither":
      return "No";
    case "untested":
      return decision.rule === "no_adjusted" ? "—" : "Can’t tell";
  }
}

function reasonText(i: BottomLineInput, d: SignalDecision, card: EvidenceRating["level"], u: ReturnType<typeof units>, derived: string[]): string {
  const k = d.lead?.lag ?? 0;
  const span = count(k, u.time);
  const hourly = i.resolution === "hourly";
  switch (d.rule) {
    case "no_adjusted":
      return i.results.market?.model && i.results.market.abnormal
        ? "It uses market-adjusted returns only, and Returns is set to Raw."
        : `It needs market-adjusted returns, and there are none here: ${i.unavailable.charAt(0).toLowerCase()}${i.unavailable.slice(1)}.`;
    case "no_p":
      return "There’s too little data to check whether Kalshi moves first.";
    case "no_lead":
      return "Kalshi doesn’t move first: no time shift with Kalshi first passed the corrected test.";
    case "both_ways":
      return "Time shifts passed both ways, so it can’t tell which moves first.";
    case "pending":
      return d.leadRating === null && i.signalCheck === undefined ? `Checking how much Kalshi’s lead rests on a few ${u.blocks[1]}…` : "Waiting for the rating above…";
    case "weak_lead": {
      const r = d.leadRating!;
      if (r.rule === "no_interval") return "Kalshi moving first couldn’t give a range, so the evidence is Weak.";
      const parts = ["Kalshi moving first is fragile, so the evidence is Weak."];
      const check = i.signalCheck;
      if (r.fragile.movement) parts.push(check?.fragility ? `Its moves were bunched into a few ${u.time[1]}.` : "Its diagnostics couldn’t be worked out.");
      if (r.fragile.leaveOneOut) {
        const loo = check?.leaveOneOut;
        if (loo) derived.push(String(loo.runs.length), String(loo.flips));
        parts.push(loo ? `Leaving out one of the ${loo.runs.length} ${u.blocks[1]} that mattered most changed it in ${loo.flips} of ${loo.runs.length} tries.` : "Its check of leaving out one day at a time couldn’t run.");
      }
      return parts.join(" ");
    }
    case "badge":
      return `The signal is never stronger than the rating above, which is ${BADGE_WORDS[card] ?? "below Moderate"}.`;
    case "too_late":
      derived.push(String(SIGNAL.closeHour - 12));
      return `Too late in the trading day: ${leadSpan(k, hourly)} can’t play out before the 4 PM close.`;
    case "no_move": {
      const what = i.variable.kind === "probability" ? "Kalshi move" : "move in the expected rate change";
      const where = hourly ? `in the ${count(d.move!.slots, u.time)} that ${leadSpan(k, hourly)} can still play out today` : `in the last ${count(d.move!.slots, u.time)}`;
      return `No ${what} of ${i.threshold} ${u.move[1]} or more ${where}.`;
    }
    case "lean": {
      const m = d.move!;
      const rise = Math.sign(d.lead!.test.estimate ?? 0) * Math.sign(m.value) > 0;
      const moved = `${upper(u.who)} ${m.value > 0 ? "rose" : "fell"} ${Math.abs(m.value).toFixed(SIGNAL.moveDigits)} ${u.move[1]} in the last ${count(m.slots, u.time)}.`;
      derived.push(Math.abs(m.value).toFixed(SIGNAL.moveDigits));
      const small =
        d.lead!.test.estimate !== null && Number(Math.abs(d.lead!.test.estimate).toFixed(2)) < EVIDENCE.smallR
          ? ` The lead is small: ${u.who === "Kalshi" ? "Kalshi’s" : "its"} moves explain only a tiny part of ${i.stock}’s later moves.`
          : "";
      return `${moved} In this window, ${i.stock} tended to ${rise ? "rise" : "fall"} against ${i.benchmark} in the ${span} after moves like that.${small}`;
    }
  }
}

/** The rules in words, then how they did in simulation. */
function rulesText(i: BottomLineInput, u: ReturnType<typeof units>): string[] {
  return [
    "These rules were set before any results were seen. The first one that applies decides.",
    "It looks only at Kalshi moving first: the time shift with Kalshi first that passes the corrected lead-lag test with the smallest p-value.",
    `That lead is rated like a scan’s lead, on its corrected p-value. It’s Weak if it rests on a few ${u.time[1]} or has no range.`,
    `Stable: leaving out any one of the ${FRAGILE.leaveOut} ${u.blocks[1]} that matter most, then testing every time shift again, doesn’t change the lead.`,
    "The evidence level is the lower of the lead’s rating and the rating above, so the signal is never stronger than that.",
    "It leans only with Moderate or Strong evidence. Strong is rare here: it needs at least two time shifts with tiny p-values.",
    `The recent move is ${u.who === "Kalshi" ? "Kalshi’s" : "the expected rate change’s"} change in the last ${u.time[1]} the lead hasn’t played out yet. It must reach the jump size.`,
    i.resolution === "hourly"
      ? "Hourly leads don’t carry over the close, so a lead that can’t play out by 4 PM gives no signal."
      : "Daily leads count every trading day, so the signal can lean at any time.",
    `${leanLabel("buy", i.benchmark)} means ${i.stock} tended to rise against ${i.benchmark} after moves like this, not that it rose.`,
    "It’s worked out at the window’s end, so a frozen link gives the same signal. A live window’s signal changes as new data comes in.",
    ...SIGNAL_SIMULATIONS,
    "Daily data, a year, and All weren’t simulated.",
  ];
}
