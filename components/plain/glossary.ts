// Short definitions of the statistical terms used across Research and the scan, in everyday words.
// Shown by <Term> (on hover or focus, or a tap), listed in full under the plain-English card, and
// in a report’s "Terms used". language.test.ts checks them for trading language and reading level.

export type TermId =
  | "correlation"
  | "p-value"
  | "confidence-interval"
  | "market-adjusted"
  | "beta"
  | "percentage-points"
  | "basis-points"
  | "bootstrap"
  | "holm-bh"
  | "fragile"
  | "lead-lag"
  | "expected-rate-change";

export interface GlossaryEntry {
  id: TermId;
  /** The term as the glossary lists it. */
  term: string;
  definition: string;
  /**
   * Phrases in the plain-English card that mark the term, first match only (case-sensitive). Kept to a
   * few words: a marker is a button, which a browser never breaks across lines.
   */
  phrases: string[];
}

export const GLOSSARY: GlossaryEntry[] = [
  {
    id: "correlation",
    term: "Correlation",
    definition:
      "A number from −1 to +1 that shows how closely two things move together. Near 0 means they don’t move together much. It doesn’t show that one causes the other.",
    phrases: ["correlation"],
  },
  {
    id: "p-value",
    term: "p-value",
    definition:
      "How often a result at least this strong would show up by chance if there were no real link. A small p-value, under 0.05, means chance alone is an unlikely answer. It doesn’t say how big the link is.",
    phrases: ["p-value"],
  },
  {
    id: "confidence-interval",
    term: "Confidence interval (95% range)",
    definition:
      "A range of values that fit the data. If the study were done again many times, ranges made this way would hold the true value about 95% of the time.",
    phrases: ["95% range", "likely range"],
  },
  {
    id: "market-adjusted",
    term: "Market-adjusted",
    definition:
      "A stock’s move minus the part that the whole market explains, using a benchmark fund such as SPY. This keeps a market-wide rise or drop from looking like a link with Kalshi.",
    phrases: ["beyond what moves in", "held fixed"],
  },
  {
    id: "beta",
    term: "Beta",
    definition: "How much a stock tends to move when the benchmark moves. A beta of 1.2 means about 1.2% for each 1% move in the benchmark.",
    phrases: [],
  },
  {
    id: "percentage-points",
    term: "Percentage points",
    definition: "The plain difference between two percentages. Going from 40% to 50% is a rise of 10 percentage points.",
    phrases: ["percentage-point"],
  },
  {
    id: "basis-points",
    term: "Basis points (bp)",
    definition: "Hundredths of a percentage point. 25 basis points is 0.25 percentage points, the usual size of one Fed rate move.",
    phrases: ["basis-point"],
  },
  {
    id: "bootstrap",
    term: "Bootstrap",
    definition:
      "A way to measure how sure a result is by redoing the test many times on reshuffled copies of the data. Here whole trading days are reweighted at random, so news that lasts a day stays together.",
    phrases: [],
  },
  {
    id: "holm-bh",
    term: "Holm and Benjamini–Hochberg",
    definition:
      "Corrections for testing many things at once, since some will look related by chance alone. Holm keeps the chance of even one false alarm at 5%. Benjamini–Hochberg keeps false alarms to about 5% of the results that pass.",
    phrases: ["correcting"],
  },
  {
    id: "fragile",
    term: "Fragile",
    definition: "The result rests on a few hours or days. Leaving one of them out could change the answer.",
    phrases: ["fragile", "Fragile"],
  },
  {
    id: "lead-lag",
    term: "Lead-lag",
    definition: "Checking whether one series tends to move before the other, by shifting one of them by an hour or more.",
    phrases: ["time shifts"],
  },
  {
    id: "expected-rate-change",
    term: "Expected rate change",
    definition:
      "Kalshi’s prices for every possible Fed decision, put together into one number. It’s the change in the Fed’s rate that the market expects, in basis points.",
    phrases: ["expected rate change"],
  },
];

export const GLOSSARY_BY_ID = Object.fromEntries(GLOSSARY.map((e) => [e.id, e])) as Record<TermId, GlossaryEntry>;
