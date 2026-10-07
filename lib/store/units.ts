// The store keeps Kalshi prices and contract counts as integers (see db/migrations/0001_init.sql),
// so values read back exactly as Kalshi sent them. Pure, so collectors, the read path, and tests
// share one conversion.

export const MICROS_PER_DOLLAR = 1_000_000;
export const HUNDREDTHS_PER_CONTRACT = 100;

function parse(value: string | number | null | undefined): number | null {
  if (value === null || value === undefined || value === "") return null;
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? n : null;
}

/**
 * A Kalshi price in dollars ("0.4500", up to 6 decimals) as integer micro-dollars (450000), or
 * null if missing. Throws if it isn't between $0 and $1, which a YES price always is.
 */
export function dollarsToMicros(value: string | number | null | undefined): number | null {
  const n = parse(value);
  if (n === null) return null;
  const micros = Math.round(n * MICROS_PER_DOLLAR);
  if (micros < 0 || micros > MICROS_PER_DOLLAR) throw new RangeError(`Kalshi price out of range: ${value}`);
  return micros;
}

export function microsToDollars(micros: number | null): number | null {
  return micros === null ? null : micros / MICROS_PER_DOLLAR;
}

/** A Kalshi contract count ("15760947.00", fixed-point with 2 decimals) as integer hundredths, or null if missing. */
export function contractsToHundredths(value: string | number | null | undefined): number | null {
  const n = parse(value);
  if (n === null) return null;
  const hundredths = Math.round(n * HUNDREDTHS_PER_CONTRACT);
  if (hundredths < 0 || !Number.isSafeInteger(hundredths)) throw new RangeError(`Kalshi contract count out of range: ${value}`);
  return hundredths;
}

export function hundredthsToContracts(hundredths: number | null): number | null {
  return hundredths === null ? null : hundredths / HUNDREDTHS_PER_CONTRACT;
}
