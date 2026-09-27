"use client";

import { useMemo, useState } from "react";
import {
  CartesianGrid,
  Line,
  LineChart,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import type { AlignedPoint } from "@/lib/analytics";
import { formatCurrency, formatDate, formatSigned } from "@/lib/format";
import { AXIS_TICK, CHART_COLORS, ChartTooltip, dayTicks } from "./ChartTooltip";

type Mode = "change" | "levels";

interface Props {
  points: AlignedPoint[];
  stockSymbol: string;
  currency: string;
}

interface Row extends AlignedPoint {
  probabilityChange: number | null;
}

/** Tooltip content keyed off the hovered row, so every series shows at that timestamp. */
function makeTooltip(render: (row: Row) => { color: string; label: string; value: string }[]) {
  function TooltipContent({ active, payload }: { active?: boolean; payload?: readonly { payload?: Row }[] }) {
    const row = payload?.[0]?.payload;
    if (!active || !row) return null;
    return <ChartTooltip t={row.t} rows={render(row)} />;
  }
  return TooltipContent;
}

const xAxisProps = {
  dataKey: "t",
  type: "number" as const,
  scale: "time" as const,
  domain: ["dataMin", "dataMax"] as [string, string],
  tickFormatter: (t: number) => formatDate(t),
  tick: AXIS_TICK,
  stroke: CHART_COLORS.axis,
  tickLine: false,
  minTickGap: 40,
};

export function ComparisonChart({ points, stockSymbol, currency }: Props) {
  const [mode, setMode] = useState<Mode>("change");

  const rows: Row[] = useMemo(() => {
    const base = points[0]?.probability ?? null;
    return points.map((p) => ({
      ...p,
      probabilityChange: p.probability !== null && base !== null ? p.probability - base : null,
    }));
  }, [points]);
  const ticks = useMemo(() => dayTicks(rows), [rows]);

  const probLabel = "Kalshi probability";
  const stockLabel = `${stockSymbol} return`;

  return (
    <div>
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap gap-4 text-xs text-ink-secondary">
          <LegendKey color={CHART_COLORS.kalshi} label={mode === "change" ? `${probLabel} change (pp)` : `${probLabel} (%)`} />
          <LegendKey color={CHART_COLORS.stock} label={mode === "change" ? `${stockLabel} (%)` : `${stockSymbol} price`} />
        </div>
        <div role="tablist" aria-label="Chart view" className="inline-flex rounded-lg border border-border p-0.5 text-xs">
          {(
            [
              ["change", "Change since start"],
              ["levels", "Levels"],
            ] as const
          ).map(([value, label]) => (
            <button
              key={value}
              role="tab"
              aria-selected={mode === value}
              onClick={() => setMode(value)}
              className={`rounded-md px-3 py-1.5 transition ${
                mode === value ? "bg-surface-raised text-ink" : "text-ink-muted hover:text-ink-secondary"
              }`}
            >
              {label}
            </button>
          ))}
        </div>
      </div>

      {mode === "change" ? (
        <div className="h-80">
          <ResponsiveContainer width="100%" height="100%">
            <LineChart data={rows} margin={{ top: 8, right: 16, bottom: 0, left: 0 }}>
              <CartesianGrid stroke={CHART_COLORS.grid} vertical={false} />
              <XAxis {...xAxisProps} ticks={ticks} />
              <YAxis
                tick={AXIS_TICK}
                stroke={CHART_COLORS.axis}
                tickLine={false}
                axisLine={false}
                width={48}
                tickFormatter={(v: number) => formatSigned(v, 1)}
              />
              <ReferenceLine y={0} stroke={CHART_COLORS.axis} />
              <Tooltip
                cursor={{ stroke: CHART_COLORS.muted, strokeWidth: 1 }}
                content={makeTooltip((r) => [
                  { color: CHART_COLORS.kalshi, label: `${probLabel} change`, value: formatSigned(r.probabilityChange, 1, " pp") },
                  { color: CHART_COLORS.stock, label: stockLabel, value: formatSigned(r.stockReturn, 2, "%") },
                ])}
              />
              <Line dataKey="probabilityChange" name={probLabel} stroke={CHART_COLORS.kalshi} strokeWidth={2} dot={false} type="stepAfter" isAnimationActive={false} />
              <Line dataKey="stockReturn" name={stockLabel} stroke={CHART_COLORS.stock} strokeWidth={2} dot={false} type="stepAfter" isAnimationActive={false} />
            </LineChart>
          </ResponsiveContainer>
        </div>
      ) : (
        <div className="grid gap-2">
          <div className="h-44">
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={rows} syncId="eventlens-levels" margin={{ top: 8, right: 16, bottom: 0, left: 0 }}>
                <CartesianGrid stroke={CHART_COLORS.grid} vertical={false} />
                <XAxis {...xAxisProps} ticks={ticks} hide />
                <YAxis
                  tick={AXIS_TICK}
                  stroke={CHART_COLORS.axis}
                  tickLine={false}
                  axisLine={false}
                  width={56}
                  domain={["auto", "auto"]}
                  tickFormatter={(v: number) => `${v.toFixed(0)}%`}
                />
                <Tooltip
                  cursor={{ stroke: CHART_COLORS.muted, strokeWidth: 1 }}
                  content={makeTooltip((r) => [
                    { color: CHART_COLORS.kalshi, label: probLabel, value: r.probability === null ? "—" : `${r.probability.toFixed(1)}%` },
                    { color: CHART_COLORS.stock, label: `${stockSymbol} price`, value: formatCurrency(r.stockPrice, currency) },
                  ])}
                />
                <Line dataKey="probability" stroke={CHART_COLORS.kalshi} strokeWidth={2} dot={false} type="stepAfter" isAnimationActive={false} />
              </LineChart>
            </ResponsiveContainer>
          </div>
          <div className="h-48">
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={rows} syncId="eventlens-levels" margin={{ top: 8, right: 16, bottom: 0, left: 0 }}>
                <CartesianGrid stroke={CHART_COLORS.grid} vertical={false} />
                <XAxis {...xAxisProps} ticks={ticks} />
                <YAxis
                  tick={AXIS_TICK}
                  stroke={CHART_COLORS.axis}
                  tickLine={false}
                  axisLine={false}
                  width={56}
                  domain={["auto", "auto"]}
                  tickFormatter={(v: number) => formatCurrency(v, currency).replace(/\.\d+$/, "")}
                />
                <Tooltip cursor={{ stroke: CHART_COLORS.muted, strokeWidth: 1 }} content={() => null} />
                <Line dataKey="stockPrice" stroke={CHART_COLORS.stock} strokeWidth={2} dot={false} type="stepAfter" isAnimationActive={false} />
              </LineChart>
            </ResponsiveContainer>
          </div>
        </div>
      )}
      <p className="mt-3 text-xs text-ink-muted">
        Series are aligned on hourly timestamps; each value is carried forward until its next observation, so the
        stock line is flat outside trading hours.
      </p>
    </div>
  );
}

function LegendKey({ color, label }: { color: string; label: string }) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <span aria-hidden className="h-0.5 w-4 rounded-full" style={{ background: color }} />
      {label}
    </span>
  );
}
