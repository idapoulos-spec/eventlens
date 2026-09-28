import type { ChangePoint } from "./changes";
import { correlationStats, type CorrelationStats } from "./correlation";

export interface LagCorrelation extends CorrelationStats {
  /**
   * Grid slots between the Kalshi change and the stock return it's paired with.
   * Positive: the Kalshi change came first. Negative: the stock return came first.
   */
  lag: number;
}

/**
 * Cross-correlation of Kalshi changes with stock returns, for lags −maxLag…maxLag.
 * At lag k, the Kalshi change in slot s is paired with the stock return in slot s + k,
 * so a pair is only formed when both slots are usable; lags never reach across a gap.
 */
export function crossCorrelation(changes: ChangePoint[], maxLag: number): LagCorrelation[] {
  const byStep = new Map(changes.map((c) => [c.step, c]));
  const result: LagCorrelation[] = [];
  for (let lag = -maxLag; lag <= maxLag; lag++) {
    const pairs = [];
    for (const c of changes) {
      const later = byStep.get(c.step + lag);
      if (later) pairs.push({ x: c.probChangePp, y: later.logReturn });
    }
    result.push({ lag, ...correlationStats(pairs) });
  }
  return result;
}
