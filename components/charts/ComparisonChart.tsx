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
import { formatCurrency, formatSigned } from "@/lib/format";
import { AXIS_TICK, CHART_COLORS, ChartTooltip } from "./ChartTooltip";
import { formatAxisTick, timeTicks } from "./time";

type Mode = "change" | "levels";

/** How the Kalshi line is named and shown: a probability (the default) or an event's expected value. */
export interface KalshiLine {
  /** e.g. "Kalshi probability". */
  label: string;
  /** Its change, e.g. "Kalshi probability change". */
  changeLabel: string;
  /** The change's unit, e.g. "pp". */
  changeUnit: string;
  /** After a level, e.g. "%" or " bp". */
  levelSuffix: string;
  /** The legend's unit for levels, e.g. "%". */
  levelUnit: string;
  /** Levels can be negative (an expected rate change), so they're shown with a sign. */
  signed: boolean;
}

const PROBABILITY_LINE: KalshiLine = {
  label: "Kalshi probability",
  changeLabel: "Kalshi probability change",
  changeUnit: "pp",
  levelSuffix: "%",
  levelUnit: "%",
  signed: false,
};

interface Props {
  points: AlignedPoint[];
  stockSymbol: string;
  currency: string;
  kalshi?: KalshiLine;
  /** A footnote line replacing the default one. */
  note?: string;
}

/** Tooltip content keyed off the hovered row, so every series shows at that timestamp. */
function makeTooltip(render: (row: AlignedPoint) => { color: string; label: string; value: string }[]) {
  function TooltipContent({ active, payload }: { active?: boolean; payload?: readonly { payload?: AlignedPoint }[] }) {
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
  tickFormatter: formatAxisTick,
  tick: AXIS_TICK,
  stroke: CHART_COLORS.axis,
  tickLine: false,
  minTickGap: 40,
};

export function ComparisonChart({ points, stockSymbol, currency, kalshi = PROBABILITY_LINE, note }: Props) {
  const [mode, setMode] = useState<Mode>("change");

  const ticks = useMemo(() => timeTicks(points), [points]);

  const probLabel = kalshi.label;
  const stockLabel = `${stockSymbol} return`;
  const level = (v: number, digits: number) =>
    kalshi.signed ? formatSigned(v, digits, kalshi.levelSuffix) : `${v.toFixed(digits)}${kalshi.levelSuffix}`;

  return (
    <div>
      <div className="mb-4 flex flex-col gap-3 sm:flex-row sm:flex-wrap sm:items-center sm:justify-between">
        <div className="flex flex-wrap gap-x-4 gap-y-1.5 text-xs text-ink-secondary">
          <LegendKey color={CHART_COLORS.kalshi} label={mode === "change" ? `${kalshi.changeLabel} (${kalshi.changeUnit})` : `${probLabel} (${kalshi.levelUnit})`} />
          <LegendKey color={CHART_COLORS.stock} label={mode === "change" ? `${stockLabel} (%)` : `${stockSymbol} price`} />
        </div>
        <div role="tablist" aria-label="Chart view" className="grid grid-cols-2 rounded-lg border border-border p-0.5 text-xs sm:inline-grid">
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
              className={`rounded-md px-3 py-2.5 transition sm:py-1.5 ${
                mode === value ? "bg-surface-raised text-ink" : "text-ink-muted hover:text-ink-secondary"
              }`}
            >
              {label}
            </button>
          ))}
        </div>
      </div>

      {mode === "change" ? (
        <div className="h-72 sm:h-80">
          <ResponsiveContainer width="100%" height="100%">
            <LineChart data={points} margin={{ top: 8, right: 16, bottom: 0, left: 0 }}>
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
                  { color: CHART_COLORS.kalshi, label: kalshi.changeLabel, value: formatSigned(r.probabilityChange, kalshi.changeUnit === "pp" ? 1 : 2, ` ${kalshi.changeUnit}`) },
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
              <LineChart data={points} syncId="eventlens-levels" margin={{ top: 8, right: 16, bottom: 0, left: 0 }}>
                <CartesianGrid stroke={CHART_COLORS.grid} vertical={false} />
                <XAxis {...xAxisProps} ticks={ticks} hide />
                <YAxis
                  tick={AXIS_TICK}
                  stroke={CHART_COLORS.axis}
                  tickLine={false}
                  axisLine={false}
                  width={56}
                  domain={["auto", "auto"]}
                  tickFormatter={(v: number) => level(v, 0)}
                />
                <Tooltip
                  cursor={{ stroke: CHART_COLORS.muted, strokeWidth: 1 }}
                  content={makeTooltip((r) => [
                    { color: CHART_COLORS.kalshi, label: probLabel, value: r.probability === null ? "—" : level(r.probability, kalshi.signed ? 2 : 1) },
                    { color: CHART_COLORS.stock, label: `${stockSymbol} price`, value: formatCurrency(r.stockPrice, currency) },
                  ])}
                />
                <Line dataKey="probability" stroke={CHART_COLORS.kalshi} strokeWidth={2} dot={false} type="stepAfter" isAnimationActive={false} />
              </LineChart>
            </ResponsiveContainer>
          </div>
          <div className="h-48">
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={points} syncId="eventlens-levels" margin={{ top: 8, right: 16, bottom: 0, left: 0 }}>
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
        {note ??
          "Series are aligned on hourly timestamps; each value is carried forward until its next observation, so the stock line is flat outside trading hours."}
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
