"use client";

import { useMemo } from "react";
import { CartesianGrid, Line, LineChart, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import type { RollingPoint } from "@/lib/analytics";
import { formatDateTime, formatSigned } from "@/lib/format";
import { AXIS_TICK, CHART_COLORS, ChartTooltip } from "./ChartTooltip";
import { formatAxisTick, formatTradingDate, timeTicks } from "./time";

/**
 * Correlation over a moving window of intervals, on a fixed −1…1 scale. Dashed lines
 * mark ±`band`, the rough 95% range for one window if there were no relationship.
 */
export function RollingCorrelationChart({ points, band, daily }: { points: RollingPoint[]; band: number; daily: boolean }) {
  const ticks = useMemo(() => timeTicks(points), [points]);
  const when = (t: number) => (daily ? formatTradingDate(t) : formatDateTime(t));
  return (
    <div className="h-60">
      <ResponsiveContainer width="100%" height="100%">
        <LineChart data={points} margin={{ top: 8, right: 16, bottom: 0, left: 0 }}>
          <CartesianGrid stroke={CHART_COLORS.grid} vertical={false} />
          <XAxis
            dataKey="t"
            type="number"
            scale="time"
            domain={["dataMin", "dataMax"]}
            ticks={ticks}
            tickFormatter={formatAxisTick}
            tick={AXIS_TICK}
            stroke={CHART_COLORS.axis}
            tickLine={false}
            minTickGap={40}
          />
          <YAxis
            domain={[-1, 1]}
            ticks={[-1, -0.5, 0, 0.5, 1]}
            tick={AXIS_TICK}
            stroke={CHART_COLORS.axis}
            tickLine={false}
            axisLine={false}
            width={44}
            tickFormatter={(v: number) => formatSigned(v, 1)}
          />
          <ReferenceLine y={0} stroke={CHART_COLORS.axis} />
          <ReferenceLine y={band} stroke={CHART_COLORS.muted} strokeDasharray="4 4" />
          <ReferenceLine y={-band} stroke={CHART_COLORS.muted} strokeDasharray="4 4" />
          <Tooltip
            cursor={{ stroke: CHART_COLORS.muted, strokeWidth: 1 }}
            content={({ active, payload }) => {
              const p = payload?.[0]?.payload as RollingPoint | undefined;
              if (!active || !p) return null;
              return (
                <ChartTooltip
                  heading={`${when(p.startT)} – ${when(p.t)}`}
                  rows={[
                    { color: CHART_COLORS.correlation, label: "correlation", value: p.r === null ? "— (no movement)" : formatSigned(p.r, 2) },
                    { color: "transparent", label: "intervals", value: String(p.n) },
                  ]}
                />
              );
            }}
          />
          <Line dataKey="r" stroke={CHART_COLORS.correlation} strokeWidth={2} dot={false} connectNulls={false} isAnimationActive={false} />
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}
