// Kalshi series whose events EventLens can analyze as a whole: one expected value from every
// outcome's probability. Each series has an outcome mapper (mapping.ts) and its units. Pure, so
// the page, the form, and search share it, on the server and in the browser.

export interface ExpectedSeries {
  /** The series ticker as Kalshi names it today. */
  series: string;
  /** Event tickers of this series, including legacy ones from before Kalshi's KX prefix. */
  events: RegExp;
  /** The expected value's unit, e.g. "bp". */
  unit: string;
  /** What the expected value is, in a sentence: "the expected rate change". */
  label: string;
}

/**
 * Fed rate decisions: one event per FOMC meeting, e.g. KXFEDDECISION-26OCT, or a legacy
 * FEDDECISION-23MAY or FEDDECISION-24JAN31. A market ticker always adds an outcome suffix
 * (…-H25), so it never matches.
 */
export const FED_DECISION: ExpectedSeries = {
  series: "KXFEDDECISION",
  events: /^(KX)?FEDDECISION-\d{2}[A-Z]{3}(\d{2})?$/,
  unit: "bp",
  label: "the expected rate change",
};

const SERIES: ExpectedSeries[] = [FED_DECISION];

/** The series whose events this ticker names, or null if it isn't a supported event ticker. */
export function supportedEvent(ticker: string): ExpectedSeries | null {
  return SERIES.find((s) => s.events.test(ticker)) ?? null;
}
