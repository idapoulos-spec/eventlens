// TypeScript names for the values the store's tables accept (db/migrations/0001_init.sql).
// Frozen with the schema: change both together, in a new migration.

export type RunCollector = "kalshi" | "stocks";
export type RunMode = "incremental" | "backfill" | "repair";
/** schedule: GitHub Actions cron; manual: workflow_dispatch; local: run from a laptop. */
export type RunTrigger = "schedule" | "manual" | "local";
export type RunStatus = "running" | "ok" | "partial" | "failed";

export type CoverageSource = "kalshi" | "twelve_data";
/** Kalshi candle periods in minutes as text, or Twelve Data intervals. */
export type CoverageInterval = KalshiPeriod | StockInterval;

export type KalshiPeriod = "60" | "1440";
export type StockInterval = "30min" | "1day";
/** Which Kalshi endpoint a row was read from: markets settled before the archive cutoff are only on /historical. */
export type KalshiSource = "live" | "historical";

export type WatchKind = "kalshi_series" | "kalshi_event" | "kalshi_market" | "stock";
