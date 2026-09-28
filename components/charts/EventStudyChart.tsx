"use client";

import {
  CartesianGrid,
  Line,
  LineChart,
  ReferenceArea,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import type { EventGroup, EventStudy } from "@/lib/analytics";
import { formatSigned } from "@/lib/format";
import { AXIS_TICK, CHART_COLORS, ChartTooltip } from "./ChartTooltip";
import { formatLag, type LagUnit } from "./LeadLagChart";

interface Row {
  k: number;
  mean: number | null;
  baseline: number | null;
}

interface Scale {
  domain: [number, number];
  ticks: number[];
  digits: number;
}

/**
 * Y-scale shared by both panels, so their paths compare at a glance: about four round
 * steps (1, 2, 2.5, or 5 × a power of ten) covering zero and every value.
 */
function scale(study: EventStudy): Scale {
  const values = [study.rises.mean, study.falls.mean, study.baseline.mean].flatMap((m) => m ?? []);
  const lo = Math.min(0, ...values);
  const hi = Math.max(0, ...values);
  const raw = Math.max(hi - lo, 0.1) / 4;
  const magnitude = 10 ** Math.floor(Math.log10(raw));
  const factor = [1, 2, 2.5, 5, 10].find((f) => f * magnitude >= raw)!;
  const step = factor * magnitude;
  const start = Math.floor(lo / step);
  const end = Math.ceil(hi / step);
  const ticks = Array.from({ length: end - start + 1 }, (_, i) => Number(((start + i) * step).toFixed(10)));
  const digits = Math.max(0, -Math.floor(Math.log10(step)) + (factor === 2.5 ? 1 : 0));
  return { domain: [ticks[0], ticks[ticks.length - 1]], ticks, digits };
}

/**
 * The stock's average cumulative return around Kalshi jumps: one panel for rises, one
 * for falls, each against the baseline over all windows of the same length.
 */
export function EventStudyChart({
  study,
  unit,
  stockSymbol,
  thresholdPp,
}: {
  study: EventStudy;
  unit: LagUnit;
  stockSymbol: string;
  thresholdPp: number;
}) {
  const y = scale(study);
  return (
    <div>
      <div className="mb-3 flex flex-wrap gap-x-4 gap-y-1.5 text-xs text-ink-secondary">
        <span className="inline-flex items-center gap-1.5">
          <span aria-hidden className="h-0.5 w-4 rounded-full" style={{ background: CHART_COLORS.stock }} />
          {stockSymbol}, average after the jumps
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span aria-hidden className="w-4 border-t-2 border-dashed" style={{ borderColor: CHART_COLORS.muted }} />
          Baseline: all {study.offsets.length}-bar windows (n = {study.baseline.n})
        </span>
      </div>
      <div className="grid gap-5 sm:grid-cols-2">
        <Panel title={`Probability rose ≥${thresholdPp} pp`} group={study.rises} study={study} unit={unit} y={y} />
        <Panel title={`Probability fell ≥${thresholdPp} pp`} group={study.falls} study={study} unit={unit} y={y} />
      </div>
    </div>
  );
}

function Panel({
  title,
  group,
  study,
  unit,
  y,
}: {
  title: string;
  group: EventGroup;
  study: EventStudy;
  unit: LagUnit;
  y: Scale;
}) {
  const data: Row[] = study.offsets.map((k, i) => ({ k, mean: group.mean?.[i] ?? null, baseline: study.baseline.mean?.[i] ?? null }));
  const first = study.offsets[0];
  const last = study.offsets[study.offsets.length - 1];
  return (
    <figure>
      <figcaption className="mb-1 text-xs font-medium text-ink-secondary">
        {title} · {group.n === 0 ? "no jumps" : `${group.n} jump${group.n === 1 ? "" : "s"}`}
      </figcaption>
      <div className="h-52">
        {group.n === 0 ? (
          <div className="flex h-full items-center justify-center rounded-lg border border-dashed border-border px-4 text-center text-xs text-ink-muted">
            No jumps this size in this window. Try a lower threshold.
          </div>
        ) : (
          <ResponsiveContainer width="100%" height="100%">
            <LineChart data={data} margin={{ top: 8, right: 16, bottom: 0, left: 0 }}>
              <CartesianGrid stroke={CHART_COLORS.grid} vertical={false} />
              {/* The jump happened during bar 0: between the close at −1 and the close at 0. */}
              <ReferenceArea x1={-1} x2={0} fill="var(--surface-raised)" fillOpacity={1} ifOverflow="hidden" />
              <XAxis
                dataKey="k"
                type="number"
                domain={[first, last]}
                ticks={study.offsets.filter((k) => k % (study.offsets.length > 11 ? 2 : 1) === 0)}
                tickFormatter={(k: number) => formatLag(k, unit)}
                tick={AXIS_TICK}
                stroke={CHART_COLORS.axis}
                tickLine={false}
              />
              <YAxis
                domain={y.domain}
                ticks={y.ticks}
                tick={AXIS_TICK}
                stroke={CHART_COLORS.axis}
                tickLine={false}
                axisLine={false}
                width={52}
                tickFormatter={(v: number) => formatSigned(v, y.digits, "%")}
              />
              <ReferenceLine y={0} stroke={CHART_COLORS.axis} />
              <Tooltip
                cursor={{ stroke: CHART_COLORS.muted, strokeWidth: 1 }}
                content={({ active, payload }) => {
                  const row = payload?.[0]?.payload as Row | undefined;
                  if (!active || !row) return null;
                  return (
                    <ChartTooltip
                      heading={row.k === -1 ? "Close before the jump (reference)" : `Bar ${formatLag(row.k, unit)}`}
                      rows={[
                        { color: CHART_COLORS.stock, label: "after jumps", value: formatSigned(row.mean, 2, "%") },
                        { color: CHART_COLORS.muted, label: "baseline", value: formatSigned(row.baseline, 2, "%") },
                      ]}
                    />
                  );
                }}
              />
              <Line
                dataKey="baseline"
                stroke={CHART_COLORS.muted}
                strokeWidth={2}
                strokeDasharray="4 4"
                dot={false}
                isAnimationActive={false}
              />
              <Line
                dataKey="mean"
                stroke={CHART_COLORS.stock}
                strokeWidth={2}
                dot={{ r: 4, fill: CHART_COLORS.stock, stroke: CHART_COLORS.surface, strokeWidth: 2 }}
                activeDot={{ r: 5, fill: CHART_COLORS.stock, stroke: CHART_COLORS.surface, strokeWidth: 2 }}
                isAnimationActive={false}
              />
            </LineChart>
          </ResponsiveContainer>
        )}
      </div>
    </figure>
  );
}
