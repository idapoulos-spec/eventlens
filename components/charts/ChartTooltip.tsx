"use client";

import { formatDateTime } from "@/lib/format";
import { formatTradingDate } from "./time";

export interface TooltipRow {
  color: string;
  label: string;
  value: string;
}

/**
 * Tooltip body: timestamp (or trading date, for daily bars), then one row per series
 * with a line key, value first.
 */
export function ChartTooltip({ t, rows, daily = false }: { t: number; rows: TooltipRow[]; daily?: boolean }) {
  return (
    <div className="rounded-lg border border-border bg-surface-raised px-3 py-2 text-xs shadow-lg">
      <p className="mb-1.5 text-ink-muted">{daily ? formatTradingDate(t) : formatDateTime(t)}</p>
      {rows.map((row) => (
        <p key={row.label} className="flex items-center gap-2 py-0.5">
          <span aria-hidden className="h-0.5 w-3 rounded-full" style={{ background: row.color }} />
          <span className="font-semibold tabular-nums text-ink">{row.value}</span>
          <span className="text-ink-secondary">{row.label}</span>
        </p>
      ))}
    </div>
  );
}

export const CHART_COLORS = {
  kalshi: "var(--series-kalshi)",
  stock: "var(--series-stock)",
  grid: "var(--grid)",
  axis: "var(--axis)",
  muted: "var(--ink-muted)",
  surface: "var(--surface)",
};

export const AXIS_TICK = { fill: "var(--ink-muted)", fontSize: 11 };
