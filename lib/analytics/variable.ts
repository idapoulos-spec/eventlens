import type { Resolution } from "./research";

// What Research studies on the Kalshi side: one market's probability (changes in percentage
// points), or an event's expected value (changes in its own unit, e.g. basis points). The
// statistics don't depend on the unit; the labels, the CSV's column names, the event study's
// jump sizes, and the scale of a change do. Plain data, so a server page can hand it to Research.

export interface KalshiVariable {
  kind: "probability" | "expected";
  /** What a YES outcome means, for one market; null for an expected value. */
  yesLabel: string | null;
  /** A change in the row's value times this is a change in `unit`: 100 turns a probability into pp. */
  scale: number;
  /** The unit of a change, e.g. "pp" or "bp". */
  unit: string;
  /** CSV columns for the value and its change. */
  csv: { value: string; change: string };
  /** Event-study jump sizes offered, in `unit`. */
  thresholds: number[];
  defaultThreshold: Record<Resolution, number>;
  text: {
    /** The changes, as a plural subject: "Kalshi changes". */
    changes: string;
    /** Who moves: "Kalshi moved in 5 hours". */
    subject: string;
    /** For "… didn't change": "Kalshi's probability". */
    value: string;
    /** "… tended to rise when {rose}": "the chance of YES rose". */
    rose: string;
    /** The event study's subtitle: "… before and after {moved} ≥2 pp". */
    moved: string;
    /** The event study's panel titles, before "≥2 pp": "Probability rose", "Probability fell". */
    rise: string;
    fall: string;
    /** After "Based on 3 rises and 2 falls": "in the chance of YES (“Hike 25bps”)". */
    movesIn: string;
    /** A sentence on how to read the sign. */
    sign: string;
    /** The regression's unit change: "each 1 pp rise in the chance of YES". */
    perUnit: string;
  };
}

/** One market: the chance that it resolves YES, which `yesLabel` names. */
export function probabilityVariable(yesLabel: string): KalshiVariable {
  return {
    kind: "probability",
    yesLabel,
    scale: 100,
    unit: "pp",
    csv: { value: "kalshi_probability", change: "prob_change_pp" },
    thresholds: [1, 2, 3, 5, 10],
    defaultThreshold: { hourly: 2, daily: 3 },
    text: {
      changes: "Kalshi changes",
      subject: "Kalshi",
      value: "Kalshi's probability",
      rose: "the chance of YES rose",
      moved: "the probability moved",
      rise: "Probability rose",
      fall: "Probability fell",
      movesIn: `in the chance of YES (“${yesLabel}”)`,
      sign: `The sign depends on what YES means (“${yesLabel}”).`,
      perUnit: "each 1 pp rise in the chance of YES",
    },
  };
}

/**
 * A whole event: its expected value E (e.g. "the expected rate change", in bp). Jump sizes from
 * the fed-history study's ΔE, where 124 hourly intervals moved at least 0.25 bp and 54 daily ones
 * at least 0.5 bp. The defaults are larger, for 90-day windows: on the ten KXFEDDECISION events
 * from 25SEP to 26OCT (measured on the store on 2026-10-14), 0.25 bp gave 28–78 hourly jumps, whose
 * ±6-hour windows covered up to 93% of the hours, and 0.5 bp left no daily interval outside the
 * jump windows in 5 of the 10, so the market-adjusted event study had no beta. 0.5 bp hourly gave
 * 4–28 jumps, and 2 bp daily 2–13.
 */
export function expectedVariable({ unit, label }: { unit: string; label: string }): KalshiVariable {
  return {
    kind: "expected",
    yesLabel: null,
    scale: 1,
    unit,
    csv: { value: `kalshi_expected_${unit}`, change: `expected_change_${unit}` },
    thresholds: [0.25, 0.5, 1, 2, 5],
    defaultThreshold: { hourly: 0.5, daily: 2 },
    text: {
      changes: `Changes in ${label} (ΔE)`,
      subject: "E",
      value: upperFirst(label),
      rose: `${label} rose`,
      moved: label,
      rise: "E rose",
      fall: "E fell",
      movesIn: `in ${label}`,
      sign: `Positive: the stock tended to rise when ${label} rose.`,
      perUnit: `each 1 ${unit} rise in ${label}`,
    },
  };
}

const upperFirst = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
