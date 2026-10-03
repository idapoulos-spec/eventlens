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
import { passes, type LagCorrelation } from "@/lib/analytics";
import { formatSigned } from "@/lib/format";
import { formatCi, formatN, formatP, passText } from "../research/stats";
import { AXIS_TICK, CHART_COLORS, ChartTooltip } from "./ChartTooltip";

export type LagUnit = "h" | "d";

/** A lag as an axis label: "0", "+2h", "−3d". */
export function formatLag(lag: number, unit: LagUnit): string {
  return lag === 0 ? "0" : `${formatSigned(lag, 0)}${unit}`;
}

/** Symmetric y-extent that fits every bar and interval, rounded up to a tenth. */
function extent(lags: LagCorrelation[]): number {
  const largest = Math.max(...lags.map((l) => Math.max(Math.abs(l.r ?? 0), ...(l.test.ci ?? [0]).map(Math.abs))));
  return Math.min(1, Math.max(0.2, Math.ceil((largest + 0.1) * 10) / 10));
}

/** Whether a lag passes: Holm (and so BH too) for exploratory lags, its own p for the primary test. */
export function lagPasses(l: LagCorrelation): "holm" | "bh" | null {
  if (l.test.role === "primary") return passes(l.test, "raw") ? "holm" : null;
  return passes(l.test, "holm") ? "holm" : passes(l.test, "bh") ? "bh" : null;
}

/**
 * A bar with a 4px rounded end at its value and a square end on the zero line, a whisker
 * for its 95% interval, a diamond past the whisker when it passes correction (filled: Holm
 * and BH; hollow: BH only), and "primary" over the primary test. Recharts puts `y` at the
 * value, with a negative height for bars below zero.
 */
function IntervalBar({ x, y, width, height, fill, payload, background, top }: BarShapeProps & { top: number }) {
  if (x == null || y == null || !width) return null;
  const plotTop = background?.y ?? 0;
  const plotHeight = background?.height ?? 0;
  const toY = (v: number) => plotTop + ((top - v) / (2 * top)) * plotHeight;
  const lag = payload as LagCorrelation | undefined;
  const ci = lag?.test.ci ?? null;
  const pass = lag ? lagPasses(lag) : null;
  height ??= 0;
  const r = Math.min(4, Math.abs(height), width / 2);
  const base = y + height;
  const d =
    height > 0
      ? `M${x},${base} V${y + r} Q${x},${y} ${x + r},${y} H${x + width - r} Q${x + width},${y} ${x + width},${y + r} V${base} Z`
      : `M${x},${base} H${x + width} V${y - r} Q${x + width},${y} ${x + width - r},${y} H${x + r} Q${x},${y} ${x},${y - r} Z`;
  const cx = x + width / 2;
  const up = (lag?.r ?? 0) >= 0;
  // The marker sits just beyond the whisker's far end, on the side the bar points to.
  const tip = ci ? toY(up ? ci[1] : ci[0]) : y;
  const markerY = up ? tip - 9 : tip + 9;
  return (
    <g>
      {height !== 0 && <path d={d} fill={fill} />}
      {ci && (
        <g stroke="var(--ink-secondary)" strokeWidth={1.5}>
          <line x1={cx} x2={cx} y1={toY(ci[0])} y2={toY(ci[1])} />
          <line x1={cx - 4} x2={cx + 4} y1={toY(ci[0])} y2={toY(ci[0])} />
          <line x1={cx - 4} x2={cx + 4} y1={toY(ci[1])} y2={toY(ci[1])} />
        </g>
      )}
      {pass && (
        <path
          d={`M${cx},${markerY - 5} L${cx + 5},${markerY} L${cx},${markerY + 5} L${cx - 5},${markerY} Z`}
          fill={pass === "holm" ? "var(--ink)" : CHART_COLORS.surface}
          stroke="var(--ink)"
          strokeWidth={1.5}
        />
      )}
      {lag?.test.role === "primary" && (
        <text x={cx} y={plotTop + 10} textAnchor="middle" fontSize={10} fill="var(--ink-secondary)">
          primary
        </text>
      )}
    </g>
  );
}

/**
 * Correlation of Kalshi changes with stock returns at each lag, with 95% intervals. Bars
 * right of 0 pair a Kalshi change with a later stock return.
 */
export function LeadLagChart({ lags, unit }: { lags: LagCorrelation[]; unit: LagUnit }) {
  const top = extent(lags);
  const data = lags.map((l) => ({ ...l, label: formatLag(l.lag, unit) }));
  return (
    <div>
      <div className="mb-2 flex flex-wrap gap-x-4 gap-y-1.5 text-xs text-ink-secondary">
        <span className="inline-flex items-center gap-1.5">
          <svg aria-hidden width="10" height="14" viewBox="0 0 10 14" stroke="var(--ink-secondary)" strokeWidth="1.5">
            <line x1="5" x2="5" y1="1" y2="13" />
            <line x1="1" x2="9" y1="1" y2="1" />
            <line x1="1" x2="9" y1="13" y2="13" />
          </svg>
          95% interval
        </span>
        <span className="inline-flex items-center gap-1.5">
          <svg aria-hidden width="12" height="12" viewBox="0 0 12 12">
            <path d="M6,1 L11,6 L6,11 L1,6 Z" fill="var(--ink)" stroke="var(--ink)" strokeWidth="1.5" />
          </svg>
          passes Holm and BH
        </span>
        <span className="inline-flex items-center gap-1.5">
          <svg aria-hidden width="12" height="12" viewBox="0 0 12 12">
            <path d="M6,1 L11,6 L6,11 L1,6 Z" fill="var(--surface)" stroke="var(--ink)" strokeWidth="1.5" />
          </svg>
          passes BH only
        </span>
      </div>
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
                const { test } = row;
                const none = { color: "transparent" };
                return (
                  <ChartTooltip
                    heading={test.role === "primary" ? `${heading} · primary test` : heading}
                    rows={[
                      { color: CHART_COLORS.correlation, label: "correlation", value: row.r === null ? "—" : formatSigned(row.r, 2) },
                      { ...none, label: "95% interval", value: formatCi(test.ci, (v) => formatSigned(v, 2)) },
                      { ...none, label: "p", value: formatP(test.p) },
                      ...(test.role === "primary"
                        ? []
                        : [
                            { ...none, label: "Holm-adjusted p", value: formatP(test.holm) },
                            { ...none, label: "BH-adjusted p", value: formatP(test.bh) },
                          ]),
                      { ...none, label: "passes", value: passText(test) },
                      { ...none, label: "pairs", value: formatN(test) },
                    ]}
                  />
                );
              }}
            />
            <Bar
              dataKey="r"
              fill={CHART_COLORS.correlation}
              maxBarSize={24}
              shape={(props: BarShapeProps) => <IntervalBar {...props} top={top} />}
              isAnimationActive={false}
            />
          </BarChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}
