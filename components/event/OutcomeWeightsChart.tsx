"use client";

import { useMemo, useState } from "react";
import { Area, AreaChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import type { WeightPoint } from "@/lib/expected/types";
import { formatProbability, formatSigned } from "@/lib/format";
import { AXIS_TICK, CHART_COLORS, ChartTooltip } from "../charts/ChartTooltip";
import { formatAxisTick, timeTicks } from "../charts/time";
import { Segmented } from "../research/parts";
import { outcomeColors } from "./colors";
import { windowed } from "./window";

const DAY_MS = 24 * 60 * 60 * 1000;
const WINDOWS = [7, 30, 90] as const;
type Days = (typeof WINDOWS)[number];

interface Props {
  points: WeightPoint[];
  /** The mapped outcomes, by value (cuts first): the order of each point's weights. */
  outcomes: { ticker: string; label: string; value: number }[];
  to: number;
  unit: string;
}

type Row = { t: number } & Record<string, number | null>;

/**
 * Each outcome's share of Σp over time, stacked by value (cuts at the bottom, hikes on top), so
 * the stack shows the distribution E averages. Empty where E is missing.
 */
export function OutcomeWeightsChart({ points, outcomes, to, unit }: Props) {
  const [days, setDays] = useState<Days>(90);
  const colors = useMemo(() => outcomeColors(outcomes), [outcomes]);
  const rows = useMemo(
    () =>
      windowed(points, to - days * DAY_MS).map(
        (p): Row => ({ t: p.t, ...Object.fromEntries(outcomes.map((o, i) => [o.ticker, p.weights === null ? null : p.weights[i]])) }),
      ),
    [points, outcomes, to, days],
  );
  const ticks = useMemo(() => timeTicks(rows), [rows]);

  return (
    <div>
      <div className="mb-3 flex justify-end">
        <Segmented label="Window" value={days} options={WINDOWS.map((d) => ({ value: d, label: `${d}D` }))} onChange={setDays} />
      </div>
      <div className="mb-3">
        <ul className="flex flex-wrap gap-x-4 gap-y-1.5 text-xs text-ink-secondary">
          {outcomes.map((o) => (
            <li key={o.ticker} className="inline-flex items-center gap-1.5">
              <span aria-hidden className="h-3 w-3 rounded-sm" style={{ background: colors.get(o.ticker) }} />
              {o.label} ({formatSigned(o.value, 0, ` ${unit}`)})
            </li>
          ))}
        </ul>
      </div>
      <div className="h-64">
        <ResponsiveContainer width="100%" height="100%">
          <AreaChart data={rows} margin={{ top: 8, right: 16, bottom: 0, left: 0 }}>
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
              width={48}
              domain={[0, 1]}
              ticks={[0, 0.25, 0.5, 0.75, 1]}
              tickFormatter={(v: number) => formatProbability(v, 0)}
            />
            <Tooltip
              cursor={{ stroke: CHART_COLORS.muted, strokeWidth: 1 }}
              content={({ active, payload }) => {
                const row = payload?.[0]?.payload as Row | undefined;
                if (!active || !row) return null;
                const missing = outcomes.every((o) => row[o.ticker] === null);
                return (
                  <ChartTooltip
                    t={row.t}
                    rows={
                      missing
                        ? [{ color: CHART_COLORS.muted, label: "E missing", value: "—" }]
                        : [...outcomes].reverse().map((o) => ({ color: colors.get(o.ticker)!, label: o.label, value: formatProbability(row[o.ticker], 1) }))
                    }
                  />
                );
              }}
            />
            {outcomes.map((o) => (
              <Area
                key={o.ticker}
                dataKey={(r: Row) => r[o.ticker]}
                name={o.label}
                stackId="weights"
                type="stepAfter"
                fill={colors.get(o.ticker)}
                fillOpacity={1}
                // A thin line in the surface color between bands, so neighbors never touch.
                stroke={CHART_COLORS.surface}
                strokeWidth={1.5}
                connectNulls={false}
                isAnimationActive={false}
              />
            ))}
          </AreaChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}
