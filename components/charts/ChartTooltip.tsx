"use client";

import { formatDateTime } from "@/lib/format";

export interface TooltipRow {
  color: string;
  label: string;
  value: string;
}

/** Tooltip body: timestamp, then one row per series with a line key, value first. */
export function ChartTooltip({ t, rows }: { t: number; rows: TooltipRow[] }) {
  return (
    <div className="rounded-lg border border-border bg-surface-raised px-3 py-2 text-xs shadow-lg">
      <p className="mb-1.5 text-ink-muted">{formatDateTime(t)}</p>
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

/**
 * X-axis ticks at local midnights within a chronologically sorted series, thinned
 * to at most `maxTicks`. Returns undefined for spans too long for daily ticks.
 */
export function dayTicks(points: { t: number }[], maxTicks = 8): number[] | undefined {
  if (points.length < 2) return undefined;
  const min = points[0].t;
  const max = points[points.length - 1].t;
  if (max - min > 21 * 24 * 60 * 60 * 1000) return undefined;

  const day = new Date(min);
  day.setHours(0, 0, 0, 0);
  day.setDate(day.getDate() + 1);
  const ticks: number[] = [];
  while (day.getTime() <= max) {
    ticks.push(day.getTime());
    day.setDate(day.getDate() + 1);
  }
  const step = Math.ceil(ticks.length / maxTicks);
  return ticks.filter((_, i) => i % step === 0);
}
