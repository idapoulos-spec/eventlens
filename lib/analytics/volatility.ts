export const TRADING_DAYS_PER_YEAR = 252;

function isPositivePrice(price: number): boolean {
  return Number.isFinite(price) && price > 0;
}

/**
 * Log returns ln(p[i] / p[i-1]) for a chronologically ordered price series.
 * Pairs involving a price that is not a positive, finite number are skipped.
 */
export function logReturns(prices: number[]): number[] {
  const returns: number[] = [];
  for (let i = 1; i < prices.length; i++) {
    const prev = prices[i - 1];
    const curr = prices[i];
    if (isPositivePrice(prev) && isPositivePrice(curr)) returns.push(Math.log(curr / prev));
  }
  return returns;
}

/** Sample standard deviation (n - 1 denominator). */
export function sampleStdDev(values: number[]): number | null {
  if (values.length < 2) return null;
  const mean = values.reduce((sum, v) => sum + v, 0) / values.length;
  const variance = values.reduce((sum, v) => sum + (v - mean) ** 2, 0) / (values.length - 1);
  return Math.sqrt(variance);
}

/**
 * Annualized realized volatility, as a percentage, from chronologically
 * ordered closing prices sampled once per period.
 */
export function realizedVolatility(
  prices: number[],
  periodsPerYear: number = TRADING_DAYS_PER_YEAR,
): number | null {
  const sd = sampleStdDev(logReturns(prices));
  if (sd === null) return null;
  return sd * Math.sqrt(periodsPerYear) * 100;
}
