// A report's charts, as inline SVG strings for the printable page: the lead-lag correlations with
// their intervals, the rolling correlation, and the event study's average paths. They plot
// statistics only (correlations, and cumulative returns averaged over at least MIN_TEST_EVENTS
// events), never a price or a single interval's return. Static and light, for print: the values
// are in the tables beside them. Palette: the dataviz reference instance's first two categorical
// slots (validated: CVD ΔE 24.7, normal-vision 33.6, both ≥ 3:1 on the surface), recessive chrome.

import { escapeHtml } from "./html";

const SURFACE = "#fcfcfb";
const INK = "#52514e";
const MUTED = "#898781";
const GRID = "#e1e0d9";
const AXIS = "#c3c2b7";
/** Rises (or the one series), then falls. */
export const SERIES = ["#2a78d6", "#eb6834"] as const;
const FONT = `font-family="system-ui, -apple-system, 'Segoe UI', sans-serif"`;

const W = 640;
const M = { top: 14, right: 16, bottom: 30, left: 48 };

/** Pixel coordinates to one decimal: no coordinate reads as a data value. */
const px = (v: number) => (Math.round(v * 10) / 10).toFixed(1);

/** About `count` round ticks covering [min, max]. */
export function niceTicks(min: number, max: number, count = 5): number[] {
  if (!(max > min)) return [min];
  const raw = (max - min) / Math.max(1, count - 1);
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw)!;
  const out: number[] = [];
  for (let v = Math.ceil(min / step - 1e-9) * step; v <= max + step * 1e-9; v += step) out.push(Number(v.toPrecision(12)));
  return out;
}

const linear = (d0: number, d1: number, r0: number, r1: number) => (v: number) => (d1 === d0 ? (r0 + r1) / 2 : r0 + ((v - d0) / (d1 - d0)) * (r1 - r0));

/** A tick's label: signed, with as few decimals as the step needs (0.25 → 2, 0.2 → 1, 5 → 0). */
export function tickLabel(v: number, step: number, suffix = ""): string {
  let decimals = Math.max(0, Math.ceil(-Math.log10(step) - 1e-9));
  const scaled = step * 10 ** decimals;
  if (Math.abs(scaled - Math.round(scaled)) > 1e-9) decimals++;
  return v === 0 ? `0${suffix}` : `${v > 0 ? "+" : "−"}${Math.abs(v).toFixed(Math.min(decimals, 4))}${suffix}`;
}

interface Frame {
  height: number;
  y: (v: number) => number;
  ticks: number[];
  body: string[];
  plot: { left: number; right: number; top: number; bottom: number };
}

/** The plot area, its y-axis gridlines and labels, and the zero line. */
function frame(height: number, values: number[], { suffix = "", clamp }: { suffix?: string; clamp?: [number, number] } = {}): Frame {
  let lo = Math.min(0, ...values);
  let hi = Math.max(0, ...values);
  const pad = (hi - lo || 1) * 0.08;
  lo -= pad;
  hi += pad;
  if (clamp) [lo, hi] = [Math.max(lo, clamp[0]), Math.min(hi, clamp[1])];
  // Out to whole ticks at both ends, so the axis is labeled at its top and bottom.
  const rough = niceTicks(lo, hi);
  const stepOf = rough.length > 1 ? rough[1] - rough[0] : 1;
  lo = Math.floor(lo / stepOf + 1e-9) * stepOf;
  hi = Math.ceil(hi / stepOf - 1e-9) * stepOf;
  if (clamp) [lo, hi] = [Math.max(lo, clamp[0]), Math.min(hi, clamp[1])];
  const ticks = niceTicks(lo, hi, Math.round((hi - lo) / stepOf) + 1);
  const plot = { left: M.left, right: W - M.right, top: M.top, bottom: height - M.bottom };
  const y = linear(lo, hi, plot.bottom, plot.top);
  const step = ticks.length > 1 ? ticks[1] - ticks[0] : 1;
  const body = ticks.map(
    (t) =>
      `<line x1="${px(plot.left)}" x2="${px(plot.right)}" y1="${px(y(t))}" y2="${px(y(t))}" stroke="${t === 0 ? AXIS : GRID}" stroke-width="1"/>` +
      `<text x="${px(plot.left - 6)}" y="${px(y(t) + 3.5)}" text-anchor="end" font-size="10" fill="${MUTED}">${escapeHtml(tickLabel(t, step, suffix))}</text>`,
  );
  return { height, y, ticks, body, plot };
}

function svg(f: Frame, label: string, parts: string[]): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${f.height}" role="img" aria-label="${escapeHtml(label)}" ${FONT}><title>${escapeHtml(label)}</title><rect width="${W}" height="${f.height}" fill="${SURFACE}"/>${[...f.body, ...parts].join("")}</svg>`;
}

const xLabel = (x: number, y: number, text: string, anchor = "middle") => `<text x="${px(x)}" y="${px(y)}" text-anchor="${anchor}" font-size="10" fill="${MUTED}">${escapeHtml(text)}</text>`;

/** A dot with the surface ring that keeps it legible over a whisker. */
const dot = (x: number, y: number, color: string) => `<circle cx="${px(x)}" cy="${px(y)}" r="4" fill="${color}" stroke="${SURFACE}" stroke-width="2"/>`;

export interface LeadLagPoint {
  /** e.g. "−3h", "0h". */
  label: string;
  r: number | null;
  ci: [number, number] | null;
  primary: boolean;
}

/** Each lag's correlation (dot) and 95% interval (whisker), on one r axis. */
export function leadLagChart(points: LeadLagPoint[], label: string): string {
  const values = points.flatMap((p) => [p.r, ...(p.ci ?? [])]).filter((v): v is number => v !== null);
  const f = frame(220, values, { clamp: [-1, 1] });
  const band = (f.plot.right - f.plot.left) / Math.max(1, points.length);
  const parts = points.flatMap((p, i) => {
    const x = f.plot.left + band * (i + 0.5);
    const out = [xLabel(x, f.height - 12, p.primary ? `${p.label} (primary)` : p.label)];
    if (p.ci) out.push(`<line x1="${px(x)}" x2="${px(x)}" y1="${px(f.y(p.ci[0]))}" y2="${px(f.y(p.ci[1]))}" stroke="${SERIES[0]}" stroke-width="2" stroke-linecap="round"/>`);
    if (p.r !== null) out.push(dot(x, f.y(p.r), SERIES[0]));
    return out;
  });
  return svg(f, label, parts);
}

export interface RollingPoint {
  t: number;
  r: number | null;
}

/** The rolling correlation over time: one line, broken where it's undefined. */
export function rollingChart(points: RollingPoint[], label: string, dateLabel: (t: number) => string): string {
  const defined = points.filter((p): p is { t: number; r: number } => p.r !== null);
  const f = frame(200, defined.map((p) => p.r), { clamp: [-1, 1] });
  const t0 = points[0]?.t ?? 0;
  const t1 = points.at(-1)?.t ?? 1;
  const x = linear(t0, t1, f.plot.left, f.plot.right);
  let d = "";
  let open = false;
  for (const p of points) {
    if (p.r === null) {
      open = false;
      continue;
    }
    d += `${open ? "L" : "M"}${px(x(p.t))} ${px(f.y(p.r))}`;
    open = true;
  }
  const ticks = [0, 0.25, 0.5, 0.75, 1].map((q) => t0 + q * (t1 - t0));
  const parts = [
    `<path d="${d}" fill="none" stroke="${SERIES[0]}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>`,
    ...ticks.map((t, i) => xLabel(x(t), f.height - 12, dateLabel(t), i === 0 ? "start" : i === ticks.length - 1 ? "end" : "middle")),
  ];
  return svg(f, label, parts);
}

export interface EventPathGroup {
  /** "After rises (n = 7)": the legend's words. */
  name: string;
  /** The average cumulative return at each bar, in percent. */
  mean: (number | null)[];
  /** Its 95% interval at each bar, in percent, or null where there's none. */
  band: ([number, number] | null)[];
}

/**
 * The event study's average paths with their 95% bands, and the baseline (the stock's normal
 * drift over windows this long). Only groups with enough events are passed in: the report leaves
 * out the paths of groups with fewer than MIN_TEST_EVENTS events.
 */
export function eventStudyChart({ labels, groups, baseline }: { labels: string[]; groups: EventPathGroup[]; baseline: (number | null)[] }, label: string): string {
  if (groups.length > SERIES.length) throw new Error("at most two groups: rises and falls");
  const values = [...groups.flatMap((g) => [...g.mean, ...g.band.flatMap((b) => b ?? [])]), ...baseline].filter((v): v is number => v !== null);
  const f = frame(240, values, { suffix: "%" });
  const legendY = f.height - 4;
  const step = (f.plot.right - f.plot.left) / Math.max(1, labels.length - 1);
  const x = (i: number) => f.plot.left + step * i;
  const line = (values: (number | null)[], color: string) => {
    let d = "";
    let open = false;
    values.forEach((v, i) => {
      if (v === null) return void (open = false);
      d += `${open ? "L" : "M"}${px(x(i))} ${px(f.y(v))}`;
      open = true;
    });
    return `<path d="${d}" fill="none" stroke="${color}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>`;
  };
  const area = (band: ([number, number] | null)[], color: string) => {
    const kept = band.map((b, i) => (b ? { i, b } : null)).filter((v): v is { i: number; b: [number, number] } => v !== null);
    if (kept.length < 2) return "";
    const upper = kept.map(({ i, b }) => `${px(x(i))} ${px(f.y(b[1]))}`);
    const lower = kept.reverse().map(({ i, b }) => `${px(x(i))} ${px(f.y(b[0]))}`);
    return `<path d="M${upper.join("L")}L${lower.join("L")}Z" fill="${color}" fill-opacity="0.1" stroke="none"/>`;
  };
  // Labels every other bar when they're crowded.
  const every = labels.length > 9 ? 2 : 1;
  const parts = [
    ...groups.map((g, k) => area(g.band, SERIES[k])),
    line(baseline, MUTED),
    ...groups.map((g, k) => line(g.mean, SERIES[k])),
    ...labels.map((l, i) => (i % every === 0 ? xLabel(x(i), f.height - 18, l) : "")),
  ];
  // The legend: a short line-key beside each name, in ink.
  const keys = [...groups.map((g, k) => ({ name: g.name, color: SERIES[k] })), { name: "Baseline (normal drift)", color: MUTED }];
  let lx = f.plot.left;
  for (const key of keys) {
    parts.push(`<line x1="${px(lx)}" x2="${px(lx + 16)}" y1="${px(legendY - 3.5)}" y2="${px(legendY - 3.5)}" stroke="${key.color}" stroke-width="2" stroke-linecap="round"/>`);
    parts.push(`<text x="${px(lx + 21)}" y="${px(legendY)}" font-size="10" fill="${INK}">${escapeHtml(key.name)}</text>`);
    lx += 30 + key.name.length * 5.6;
  }
  return svg({ ...f, height: f.height + 6 }, label, parts);
}
