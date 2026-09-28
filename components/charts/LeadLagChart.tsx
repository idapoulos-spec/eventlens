"use client";

import {
  Bar,
  BarChart,
  CartesianGrid,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
  type BarShapeProps,
} from "recharts";
import type { LagCorrelation } from "@/lib/analytics";
import { formatSigned } from "@/lib/format";
import { AXIS_TICK, CHART_COLORS, ChartTooltip } from "./ChartTooltip";

export type LagUnit = "h" | "d";

/** A lag as an axis label: "0", "+2h", "−3d". */
export function formatLag(lag: number, unit: LagUnit): string {
  return lag === 0 ? "0" : `${formatSigned(lag, 0)}${unit}`;
}

/** Symmetric y-extent that fits every bar and band, rounded up to a tenth. */
function extent(lags: LagCorrelation[]): number {
  const largest = Math.max(...lags.map((l) => Math.max(Math.abs(l.r ?? 0), l.band ?? 0)));
  return Math.min(1, Math.max(0.2, Math.ceil((largest + 0.05) * 10) / 10));
}

/**
 * A bar with a 4px rounded end at its value and a square end on the zero line, plus
 * dashed marks at ± its own band: each lag has its own number of pairs, so its own
 * range for "no relationship". Recharts puts `y` at the value, with a negative height
 * for bars below zero.
 */
function BandedBar({ x, y, width, height, fill, payload, background, top }: BarShapeProps & { top: number }) {
  if (x == null || y == null || !width) return null;
  // The plot area, which the band marks are placed within.
  const plotTop = background?.y ?? 0;
  const plotHeight = background?.height ?? 0;
  const toY = (v: number) => plotTop + ((top - v) / (2 * top)) * plotHeight;
  const band = (payload as LagCorrelation | undefined)?.band ?? null;
  height ??= 0;
  const r = Math.min(4, Math.abs(height), width / 2);
  const base = y + height;
  const d =
    height > 0
      ? `M${x},${base} V${y + r} Q${x},${y} ${x + r},${y} H${x + width - r} Q${x + width},${y} ${x + width},${y + r} V${base} Z`
      : `M${x},${base} H${x + width} V${y - r} Q${x + width},${y} ${x + width - r},${y} H${x + r} Q${x},${y} ${x},${y - r} Z`;
  return (
    <g>
      {height !== 0 && <path d={d} fill={fill} />}
      {band !== null &&
        [band, -band].map((b) => (
          <line
            key={b}
            x1={x - 6}
            x2={x + width + 6}
            y1={toY(b)}
            y2={toY(b)}
            stroke={CHART_COLORS.muted}
            strokeWidth={1.5}
            strokeDasharray="3 3"
          />
        ))}
    </g>
  );
}

/**
 * Correlation of Kalshi changes with stock returns at each lag. Bars right of 0 pair a
 * Kalshi change with a later stock return. Dashed marks on each lag show its rough 95%
 * range if there were no relationship.
 */
export function LeadLagChart({ lags, unit }: { lags: LagCorrelation[]; unit: LagUnit }) {
  const top = extent(lags);
  const data = lags.map((l) => ({ ...l, label: formatLag(l.lag, unit) }));
  return (
    <div className="h-60">
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={data} margin={{ top: 8, right: 16, bottom: 0, left: 0 }}>
          <CartesianGrid stroke={CHART_COLORS.grid} vertical={false} />
          <XAxis dataKey="label" tick={AXIS_TICK} stroke={CHART_COLORS.axis} tickLine={false} interval={0} />
          <YAxis
            domain={[-top, top]}
            tick={AXIS_TICK}
            stroke={CHART_COLORS.axis}
            tickLine={false}
            axisLine={false}
            width={44}
            tickFormatter={(v: number) => formatSigned(v, 1)}
          />
          <ReferenceLine y={0} stroke={CHART_COLORS.axis} />
          <Tooltip
            cursor={{ fill: "var(--surface-raised)" }}
            content={({ active, payload }) => {
              const row = payload?.[0]?.payload as (LagCorrelation & { label: string }) | undefined;
              if (!active || !row) return null;
              const heading =
                row.lag === 0 ? "Same interval" : row.lag > 0 ? `Kalshi first, by ${row.label.slice(1)}` : `Stock first, by ${row.label.slice(1)}`;
              return (
                <ChartTooltip
                  heading={heading}
                  rows={[
                    { color: CHART_COLORS.correlation, label: "correlation", value: row.r === null ? "—" : formatSigned(row.r, 2) },
                    { color: "transparent", label: "pairs", value: String(row.n) },
                    { color: "transparent", label: "range with no relationship", value: row.band === null ? "—" : `±${row.band.toFixed(2)}` },
                  ]}
                />
              );
            }}
          />
          <Bar
            dataKey="r"
            fill={CHART_COLORS.correlation}
            maxBarSize={24}
            shape={(props: BarShapeProps) => <BandedBar {...props} top={top} />}
            isAnimationActive={false}
          />
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}
