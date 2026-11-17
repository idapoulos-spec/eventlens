import { computeChanges, type ChangePoint } from "./changes";
import { calibrationFor, evidenceRating, type EvidenceRating } from "./evidence";
import { fragility, leaveOneOut } from "./fragility";
import { ALPHA, type TestResult } from "./inference";
import { crossCorrelation } from "./lead-lag";
import { adjustedChanges, benchmarkReturnsByT, fitMarketModel, type MarketModel } from "./market-model";
import type { ResearchRow } from "./research";
import { signalCheck, signalDecision, type SignalDecision } from "./signal";
import { lastSessions, simulateMarketRows, type MarketSimOptions } from "./test-helpers";

// One simulated data set for the experimental signal's simulations (signal-rates.sim.test.ts), as
// the README's "Checking the signal by simulation" sets them: the rating simulations' hourly data,
// every window ending at 1:00 PM New York in its last session, right after Kalshi's change in the
// hour ending then was set to ±3 pp, with the rest of that session kept aside to see what the stock
// did next (3 or 4 hours: the simulator's sessions are stamped in UTC, so from March they run
// 11:00–17:00 New York). test-helpers.ts gains only opt-in options, so every pinned scenario's data stays the same.

export const SIGNAL_SIM = {
  /** Kalshi's forced change (pp) in the hour ending at the window's end: up for even seeds, down for odd. */
  jumpPp: 3,
  /** The window ends at this hour, New York time, in its last session, right after Kalshi's forced change. */
  endHour: 13,
  /** The page's hourly jump size for a market (pp). */
  threshold: 2,
  /** The lead-lag family's lags each way, hourly. */
  maxLag: 3,
} as const;

const NY_HOUR = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", hour: "numeric", hourCycle: "h23" });
const nyHour = (t: number) => Number(NY_HOUR.format(t));

/** The rating simulations' design: hourly, Kalshi tracking the benchmark, shared volatility. */
const DESIGN = { resolution: "hourly", sharedVolatility: true, kalshiInMarket: 0.1 } as const;

export interface SignalSimOptions {
  /** The window's sessions: 21, 62, or 124 (30, 90, or 180 days). */
  window: number;
  seed: number;
  /** % per pp in the same hour. */
  effect?: number;
  /** % per pp in the hour after Kalshi's change (Kalshi first). */
  lead?: number;
}

/** The data set: the loaded rows and the window up to 1:00 PM of the last session, and the rows after it. */
export function signalDataSet({ window, seed, effect = 0, lead = 0 }: SignalSimOptions) {
  const options: MarketSimOptions = {
    ...DESIGN,
    // The market model on the 62 loaded sessions up to 90 days, on the window itself beyond.
    sessions: Math.max(62, window),
    seed,
    effect,
    ...(lead !== 0 && { lagEffect: { lag: 1, effect: lead } }),
    lastSessionJump: { nyHour: SIGNAL_SIM.endHour, pp: seed % 2 === 0 ? SIGNAL_SIM.jumpPp : -SIGNAL_SIM.jumpPp },
  };
  const { rows, closesByT } = simulateMarketRows(options);
  // The simulator stamps sessions in UTC, so the row at 1:00 PM New York is found by its time.
  const end = rows.findLastIndex((r) => nyHour(r.t) === SIGNAL_SIM.endHour);
  const future = rows.length - 1 - end;
  return {
    full: rows.slice(0, end + 1),
    windowRows: lastSessions(rows, window, "hourly").slice(0, -future),
    /** The window's last row (1:00 PM) and the rest of its session. */
    after: rows.slice(end),
    closesByT,
    jumpSign: seed % 2 === 0 ? 1 : -1,
  };
}

export interface SignalSimResult {
  decision: SignalDecision;
  /** The sign of Kalshi's forced jump. */
  jumpSign: number;
  /** For a Leans Buy or Sell: the stock's abnormal log return over the lead's next k hours, by the window's market model. */
  realized: number | null;
}

/** The sum of the stock's abnormal log returns over the first k intervals of `after`. */
export function abnormalAfter(after: ResearchRow[], closesByT: ReadonlyMap<number, number>, model: MarketModel, k: number): number {
  let sum = 0;
  for (let j = 1; j <= k; j++) {
    const [a, b] = [after[j - 1], after[j]];
    const rm = Math.log(closesByT.get(b.t)! / closesByT.get(a.t)!);
    sum += Math.log(b.stockClose / a.stockClose) - model.alpha - model.beta * rm;
  }
  return sum;
}

/**
 * The signal for one data set, as the page works it out, computing only what the rules need to
 * decide the label: the lead's check once a Kalshi-first lead passes alone, and the card's rating
 * once the lead rates Moderate or Strong. The card's rating then needs the leave-one-out check when
 * p < 0.05; when p ≥ 0.05 it is Not enough data or No clear link (both below Moderate, so S7 either
 * way), and the detectable size that tells them apart isn't computed.
 */
export function simulateSignal(options: SignalSimOptions, draws?: number): SignalSimResult {
  const { full, windowRows, after, closesByT, jumpSign } = signalDataSet(options);
  const model = fitMarketModel(full, closesByT)!;
  const changes = computeChanges(windowRows, 100).changes;
  const abnormal = adjustedChanges(changes, benchmarkReturnsByT(full, closesByT), model);
  const lags = crossCorrelation(abnormal, SIGNAL_SIM.maxLag, "hourly", { primaryLag: 0, refit: model.sample, draws });
  const days = options.window === 21 ? 30 : options.window === 62 ? 90 : 180;
  const base = {
    lags,
    calibration: calibrationFor("hourly", days, days > 90),
    changes: abnormal,
    end: windowRows[windowRows.length - 1],
    resolution: "hourly" as const,
    threshold: SIGNAL_SIM.threshold,
  };
  const result = (decision: SignalDecision): SignalSimResult => ({
    decision,
    jumpSign,
    realized: decision.label === "buy" || decision.label === "sell" ? abnormalAfter(after, closesByT, model, decision.lead!.lag) : null,
  });

  // S1–S4 need neither check.
  const first = signalDecision({ ...base, card: "pending", check: undefined });
  if (first.rule !== "pending") return result(first);
  const lead = first.lead!;
  const check = signalCheck({ full, closesByT, changes, abnormal, model, resolution: "hourly", lag: lead.lag, lead: lead.test, maxLag: SIGNAL_SIM.maxLag, draws });
  // A badge of Strong can't decide anything before S7, so this shows whether the lead itself holds (S6).
  const probe = signalDecision({ ...base, card: "strong", check });
  if (probe.rule === "weak_lead") return result(probe);
  const primary = lags.find((l) => l.lag === 0)!.test;
  return result(signalDecision({ ...base, card: cardRating({ full, closesByT, changes, abnormal, model, primary, days, draws }), check }));
}

/** The card's rating, as far as the signal needs it. */
function cardRating({ full, closesByT, changes, abnormal, model, primary, days, draws }: {
  full: ResearchRow[];
  closesByT: ReadonlyMap<number, number>;
  changes: ChangePoint[];
  abnormal: ChangePoint[];
  model: MarketModel;
  primary: TestResult;
  days: number;
  draws?: number;
}): EvidenceRating["level"] {
  const significant = primary.p !== null && primary.p < ALPHA;
  const f = primary.p === null ? null : fragility(abnormal, model, "hourly");
  const loo = significant && f ? leaveOneOut({ full, closesByT, changes, resolution: "hourly", primary, fragility: f, draws }) : null;
  return evidenceRating({ primary, fragility: f, leaveOneOut: loo, detectable: significant ? undefined : null, calibration: calibrationFor("hourly", days, days > 90) }).level;
}
