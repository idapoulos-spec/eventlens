/**
 * Where a market is in its lifecycle:
 * - open: trading now, so quotes are live
 * - not_trading: listed but not open for trading (initialized, inactive)
 * - closed: trading has ended and the result is not final yet (closed, disputed)
 * - settled: the result is known (determined, amended, finalized)
 */
export type MarketPhase = "open" | "not_trading" | "closed" | "settled";

const CLOSED_STATUSES = new Set(["closed", "disputed"]);
const SETTLED_STATUSES = new Set(["determined", "amended", "finalized", "settled"]);

export function marketPhase(status: string): MarketPhase {
  if (status === "active") return "open";
  if (SETTLED_STATUSES.has(status)) return "settled";
  if (CLOSED_STATUSES.has(status)) return "closed";
  return "not_trading";
}
