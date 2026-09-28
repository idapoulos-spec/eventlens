"use client";

import { useMemo } from "react";
import { CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import type { TimePoint } from "@/lib/analytics";
import { formatProbability } from "@/lib/format";
import { AXIS_TICK, CHART_COLORS, ChartTooltip } from "./ChartTooltip";
import { formatAxisTick, timeTicks } from "./time";

interface Props {
  points: TimePoint[];
  color: "kalshi" | "stock";
  label: string;
  /** How values appear in the tooltip and on the Y axis. "probability" expects values in [0, 1]. */
  format: "probability" | "currency";
  currency?: string;
  /**
   * "hourly": each value holds until the next observation, so it's drawn as steps and the
   * tooltip shows the time. "daily": closes joined by lines, with the trading date in the tooltip.
   */
  cadence: "hourly" | "daily";
}

/** A single time series. The card title names it, so there is no legend. */
export function SingleSeriesChart({ points, color, label, format, currency = "USD", cadence }: Props) {
  const stroke = CHART_COLORS[color];
  const ticks = useMemo(() => timeTicks(points), [points]);
  const fmt = (v: number, digits: number) =>
    format === "probability"
      ? formatProbability(v, digits)
      : new Intl.NumberFormat("en-US", { style: "currency", currency, maximumFractionDigits: digits }).format(v);

  return (
    <div className="h-64">
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
            tick={AXIS_TICK}
            stroke={CHART_COLORS.axis}
            tickLine={false}
            axisLine={false}
            width={56}
            domain={["auto", "auto"]}
            tickFormatter={(v: number) => fmt(v, 0)}
          />
          <Tooltip
            cursor={{ stroke: CHART_COLORS.muted, strokeWidth: 1 }}
            content={({ active, payload }) => {
              const p = payload?.[0]?.payload as TimePoint | undefined;
              if (!active || !p) return null;
              return <ChartTooltip t={p.t} daily={cadence === "daily"} rows={[{ color: stroke, label, value: fmt(p.value, 2) }]} />;
            }}
          />
          <Line
            dataKey="value"
            stroke={stroke}
            strokeWidth={2}
            dot={false}
            type={cadence === "hourly" ? "stepAfter" : "linear"}
            isAnimationActive={false}
          />
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}
