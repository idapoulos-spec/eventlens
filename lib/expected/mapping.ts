// What each outcome of a Fed decision event is worth, in basis points, read from its contract text.
// Pure, so it's tested directly. A value is never guessed: an outcome whose sources don't parse or
// don't agree is left unmapped, with the reason, and then the event has no expected value.

import type { RawMarket } from "@/lib/kalshi/types";

/** One outcome market's contract text, as Kalshi returns it (live, archived, or stored). */
export type OutcomeContract = Pick<RawMarket, "ticker" | "event_ticker" | "yes_sub_title" | "title"> & {
  /** e.g. {"Cut": ">25"}. Kalshi left it out for KXFEDDECISION-25JAN-H0. */
  custom_strike?: Record<string, unknown> | null;
  rules_primary?: string | null;
};

type Direction = "cut" | "hike" | "hold";

/** A decision as one source states it. */
interface Decision {
  direction: Direction;
  /** Basis points; 0 for hold. */
  amount: number;
  /** "> X": more than X. Null when the source can't tell (live rules text drops the ">"). */
  openEnded: boolean | null;
}

/** How a mapped outcome's value was established. */
export type MappedBy =
  /** custom_strike and the YES label agree, and the title and rules don't contradict them. */
  | "strike_and_label"
  /** No custom_strike: the YES label, the title, and the rules all state the same decision. */
  | "label_title_rules";

export interface MappedOutcome {
  ticker: string;
  /** The YES label, e.g. "Cut >25bps". */
  label: string;
  /** Basis points: a cut is negative; "more than X" counts as the next 25 bp step. */
  value: number;
  mappedBy: MappedBy;
  /**
   * Whether the ticker's suffix reads as the value (C25, H0, C26 or C>25 for "Cut >25"). It never
   * decides the value: three legacy markets (C24, TC25, TH50) have irregular suffixes.
   */
  suffix: "agrees" | "irregular";
}

export type UnmappedReason =
  | "label_unreadable"
  | "strike_unreadable"
  | "strike_disagrees"
  | "title_contradicts"
  | "rules_contradict"
  | "unconfirmed_without_strike"
  | "duplicate_value";

export interface UnmappedOutcome {
  ticker: string;
  label: string | null;
  reason: UnmappedReason;
}

/** Why an event has no expected value, beyond its outcomes. */
export type EventProblem = "not_exclusive" | "no_outcomes";

export interface EventMapping {
  /** Every outcome, mapped, in the order given; empty if any outcome failed. */
  outcomes: MappedOutcome[];
  unmapped: UnmappedOutcome[];
  problem: EventProblem | null;
}

// Kalshi's YES labels for "no change", across its relabelings since 2023.
const HOLD_LABELS = new Set(["No change", "Hike 0bps", "No cut/hike", "Fed maintains rate"]);
const LABEL = /^(Cut|Hike) (>?)(\d+)(?:bps)?$/;
const STRIKE = /^(>?)\s*(\d+)\s*(?:bps)?$/;
const TITLE = /\b(Cut|Hike) rates by (>?)(\d+)(?:\s*bps)?\b/;
// Live rules read "a Cut of   25bps" for "Cut >25bps": the ">" is dropped, the spaces stay.
const RULES = /\bdoes an? (Cut|Hike) of\s+(>?)\s*(\d+)\s*bps\b/;
// The next 25 bp step above an open-ended outcome's threshold.
const STEP = 25;

function decision(word: string, gt: string, digits: string, openKnown = true): Decision {
  const amount = Number(digits);
  if (amount === 0 && gt === "") return { direction: "hold", amount: 0, openEnded: false };
  return { direction: word.toLowerCase() as Direction, amount, openEnded: gt === ">" ? true : openKnown ? false : null };
}

function fromLabel(label: string | undefined): Decision | null {
  if (!label) return null;
  if (HOLD_LABELS.has(label)) return { direction: "hold", amount: 0, openEnded: false };
  const m = LABEL.exec(label);
  return m ? decision(m[1], m[2], m[3]) : null;
}

function fromStrike(strike: Record<string, unknown>): Decision | null {
  const keys = Object.keys(strike);
  if (keys.length !== 1 || (keys[0] !== "Cut" && keys[0] !== "Hike")) return null;
  const value = strike[keys[0]];
  const m = typeof value === "string" ? STRIKE.exec(value.trim()) : null;
  return m ? decision(keys[0], m[1], m[2]) : null;
}

// The title and the rules can confirm the direction and amount; only a ">" in them says "more than".
const fromTitle = (title: string | undefined) => {
  const m = title ? TITLE.exec(title) : null;
  return m ? decision(m[1], m[2], m[3], false) : null;
};

const fromRules = (rules: string | null | undefined) => {
  const m = rules ? RULES.exec(rules) : null;
  return m ? decision(m[1], m[2], m[3], false) : null;
};

/** Whether `b` states the same decision as `a`; an open-endedness `b` can't tell isn't a contradiction. */
function same(a: Decision, b: Decision): boolean {
  if (a.direction !== b.direction || a.amount !== b.amount) return false;
  return b.openEnded === null || a.openEnded === null || a.openEnded === b.openEnded;
}

function valueOf({ direction, amount, openEnded }: Decision): number {
  if (direction === "hold") return 0;
  const bp = openEnded ? amount + STEP : amount;
  return direction === "cut" ? -bp : bp;
}

/** Suffixes that read as the decision: H0; C25 for "Cut 25"; C>25 or C26 for "Cut >25". */
function suffixes({ direction, amount, openEnded }: Decision): string[] {
  if (direction === "hold") return ["H0"];
  const letter = direction === "cut" ? "C" : "H";
  return openEnded ? [`${letter}>${amount}`, `${letter}${amount + 1}`] : [`${letter}${amount}`];
}

/** One outcome's value, or why it has none. */
export function mapOutcome(contract: OutcomeContract): { ok: true; outcome: MappedOutcome } | { ok: false; outcome: UnmappedOutcome } {
  const label = contract.yes_sub_title ?? null;
  const fail = (reason: UnmappedReason) => ({ ok: false as const, outcome: { ticker: contract.ticker, label, reason } });

  const fromYes = fromLabel(contract.yes_sub_title);
  if (!fromYes) return fail("label_unreadable");
  const title = fromTitle(contract.title);
  const rules = fromRules(contract.rules_primary);

  let mappedBy: MappedBy;
  if (contract.custom_strike) {
    const strike = fromStrike(contract.custom_strike);
    if (!strike) return fail("strike_unreadable");
    if (!same(fromYes, strike)) return fail("strike_disagrees");
    if (title && !same(fromYes, title)) return fail("title_contradicts");
    if (rules && !same(fromYes, rules)) return fail("rules_contradict");
    mappedBy = "strike_and_label";
  } else {
    // Without the structured strike, the title and the rules must both state the same decision,
    // and the title must say "more than" exactly when the label does.
    if (!title || !rules || !same(fromYes, title) || !same(fromYes, rules) || (title.openEnded === true) !== fromYes.openEnded) {
      return fail("unconfirmed_without_strike");
    }
    mappedBy = "label_title_rules";
  }

  const prefix = `${contract.event_ticker}-`;
  const suffix = contract.ticker.startsWith(prefix) ? contract.ticker.slice(prefix.length) : "";
  return {
    ok: true,
    outcome: {
      ticker: contract.ticker,
      label: contract.yes_sub_title!,
      value: valueOf(fromYes),
      mappedBy,
      suffix: suffixes(fromYes).includes(suffix) ? "agrees" : "irregular",
    },
  };
}

/**
 * Every outcome of an event. The expected value needs all of them mapped, to distinct values, in
 * an event whose outcomes exclude each other; otherwise `outcomes` is empty and the reasons say why.
 */
export function mapEvent(contracts: OutcomeContract[], mutuallyExclusive: boolean | null | undefined): EventMapping {
  if (mutuallyExclusive === false) return { outcomes: [], unmapped: [], problem: "not_exclusive" };
  if (contracts.length === 0) return { outcomes: [], unmapped: [], problem: "no_outcomes" };

  const mapped: MappedOutcome[] = [];
  const unmapped: UnmappedOutcome[] = [];
  for (const c of contracts) {
    const r = mapOutcome(c);
    if (r.ok) mapped.push(r.outcome);
    else unmapped.push(r.outcome);
  }
  const counts = new Map<number, number>();
  for (const o of mapped) counts.set(o.value, (counts.get(o.value) ?? 0) + 1);
  for (const o of mapped) {
    if (counts.get(o.value)! > 1) unmapped.push({ ticker: o.ticker, label: o.label, reason: "duplicate_value" });
  }
  return unmapped.length > 0 ? { outcomes: [], unmapped, problem: null } : { outcomes: mapped, unmapped, problem: null };
}

export const UNMAPPED_TEXT: Record<UnmappedReason, string> = {
  label_unreadable: "its YES label isn’t one of the decisions EventLens can read",
  strike_unreadable: "its structured strike (custom_strike) can’t be read",
  strike_disagrees: "its structured strike and its YES label state different decisions",
  title_contradicts: "its title states a different decision from its YES label",
  rules_contradict: "its rules state a different decision from its YES label",
  unconfirmed_without_strike: "it has no structured strike, and its title and rules don’t both confirm its YES label",
  duplicate_value: "another outcome maps to the same rate change, so they overlap",
};

export const EVENT_PROBLEM_TEXT: Record<EventProblem, string> = {
  not_exclusive: "Kalshi doesn’t mark this event’s outcomes as mutually exclusive, so their probabilities can’t be averaged",
  no_outcomes: "no outcome markets were found for this event",
};

export const MAPPED_BY_TEXT: Record<MappedBy, string> = {
  strike_and_label: "strike and label agree",
  label_title_rules: "label, title, and rules agree (no strike)",
};
