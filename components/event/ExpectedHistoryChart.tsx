"use client";

import { useMemo, useState } from "react";
import { CartesianGrid, Line, LineChart, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import type { ChartPoint } from "@/lib/expected/types";
import { formatSigned } from "@/lib/format";
import { AXIS_TICK, CHART_COLORS, ChartTooltip } from "../charts/ChartTooltip";
import { formatAxisTick, timeTicks } from "../charts/time";
import { Segmented } from "../research/parts";
import { windowed } from "./window";

const DAY_MS = 24 * 60 * 60 * 1000;
const WINDOWS = [7, 30, 90] as const;
type Days = (typeof WINDOWS)[number];

/** E over time as steps (each hourly value holds until the next), with gaps where it's missing. */
export function ExpectedHistoryChart({ points, to, unit, label }: { points: ChartPoint[]; to: number; unit: string; label: string }) {
  const [days, setDays] = useState<Days>(90);
  const shown = useMemo(() => windowed(points, to - days * DAY_MS), [points, to, days]);
  const ticks = useMemo(() => timeTicks(shown), [shown]);
  const missing = shown.some((p) => p.value === null);

  return (
    <div>
      <div className="mb-3 flex justify-end">
        <Segmented label="Window" value={days} options={WINDOWS.map((d) => ({ value: d, label: `${d}D` }))} onChange={setDays} />
      </div>
      <div className="h-64">
        <ResponsiveContainer width="100%" height="100%">
          <LineChart data={shown} margin={{ top: 8, right: 16, bottom: 0, left: 0 }}>
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
              tickFormatter={(v: number) => formatSigned(v, 0, ` ${unit}`)}
            />
            <ReferenceLine y={0} stroke={CHART_COLORS.axis} />
            <Tooltip
              cursor={{ stroke: CHART_COLORS.muted, strokeWidth: 1 }}
              content={({ active, payload }) => {
                const p = payload?.[0]?.payload as ChartPoint | undefined;
                if (!active || !p) return null;
                return (
                  <ChartTooltip
                    t={p.t}
                    rows={[{ color: CHART_COLORS.kalshi, label, value: p.value === null ? "missing" : formatSigned(p.value, 2, ` ${unit}`) }]}
                  />
                );
              }}
            />
            <Line dataKey="value" stroke={CHART_COLORS.kalshi} strokeWidth={2} dot={false} type="stepAfter" connectNulls={false} isAnimationActive={false} />
          </LineChart>
        </ResponsiveContainer>
      </div>
      {missing && <p className="mt-2 text-xs text-ink-muted">Gaps: hours where E is missing (see the event panel for the rules).</p>}
    </div>
  );
}
