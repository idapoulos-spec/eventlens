// The "how they moved together" gauge's geometry: where the needle, the band, the ticks, and the
// labels go for one r and its 95% range, on a semicircle from −0.5 (Opposite, left) through 0 (No
// link, top) to +0.5 (Together, right). Pure, and the same for the page (Gauge.tsx) and a printable
// report (components/report/gaugeSvg.ts), so both draw exactly the numbers they're given. Values past
// the scale stop at its edge, flagged, and get an arrow there. The words that go with it are in
// summary.ts (gaugeOf), beside the headline whose size words they share.

/** The scale runs from −GAUGE_SCALE to +GAUGE_SCALE: correlations here are small, and a ±1 dial would barely move. */
export const GAUGE_SCALE = 0.5;

export type GaugeSize = "full" | "compact";

interface Dims {
  width: number;
  height: number;
  cx: number;
  cy: number;
  /** The ring's centerline. */
  radius: number;
  track: number;
  band: number;
  /** The surface-colored gap around the band and the needle (the skill's 2 px surface ring). */
  gap: number;
  /** How far the needle reaches: short of the ring, so it never runs into the band. */
  needle: number;
  /** How far the 0 tick and the end ticks reach past the ring, inside and out. */
  tick: number;
  font: number;
}

export const GAUGE_DIMS: Record<GaugeSize, Dims> = {
  full: { width: 240, height: 140, cx: 120, cy: 110, radius: 84, track: 8, band: 12, gap: 2, needle: 70, tick: 10, font: 11 },
  compact: { width: 176, height: 110, cx: 88, cy: 84, radius: 60, track: 6, band: 10, gap: 2, needle: 48, tick: 8, font: 11 },
};

/**
 * A point, rounded to 0.1 as the report's charts round theirs, so no coordinate reads as a data value
 * (licensing.test.tsx checks a report's two-decimal numbers against the benchmark's prices). That
 * moves a drawn value by less than 0.0005 on the scale.
 */
export interface Point {
  x: number;
  y: number;
}

/** Which edge a value is past, if any. */
export type Past = "low" | "high" | null;

export interface GaugeGeometry {
  dims: Dims;
  needle: { from: Point; to: Point; past: Past };
  /** The range as an arc on the ring (SVG path), and the surface gap drawn under it; null without a range, or with all of it past one edge. */
  band: { path: string; gapPath: string; from: Point; to: Point } | null;
  /** Which ends of the range were cut at the scale's edge. */
  bandPast: { low: boolean; high: boolean; all: Past } | null;
  /** The edges that carry an arrow (a triangle, as an SVG path): something there runs past the scale. */
  arrows: { edge: "low" | "high"; path: string }[];
  /** The 0 tick ("No link") and the two end ticks. */
  ticks: { at: number; from: Point; to: Point }[];
  labels: { text: string; x: number; y: number; anchor: "start" | "middle" | "end" }[];
}

const round = (v: number) => Math.round(v * 10) / 10;
const clamp = (v: number) => Math.max(-GAUGE_SCALE, Math.min(GAUGE_SCALE, v));
const pastOf = (v: number): Past => (v < -GAUGE_SCALE ? "low" : v > GAUGE_SCALE ? "high" : null);

/** The angle of a value, in radians from the right (math convention, y up): −0.5 → π, 0 → π/2, +0.5 → 0. Clamped to the scale. */
export function angleOf(v: number): number {
  return (Math.PI / 2) * (1 - clamp(v) / GAUGE_SCALE);
}

/** The point at a value's angle and a distance from the hub. */
export function pointAt(d: Dims, angle: number, radius: number): Point {
  return { x: round(d.cx + radius * Math.cos(angle)), y: round(d.cy - radius * Math.sin(angle)) };
}

/** The value a point on the gauge stands for, from its angle about the hub: the inverse of angleOf, for checking a drawing. */
export function valueAt(size: GaugeSize, { x, y }: Point): number {
  const d = GAUGE_DIMS[size];
  const angle = Math.atan2(d.cy - y, x - d.cx);
  return GAUGE_SCALE * (1 - (2 * angle) / Math.PI);
}

const fmt = (v: number) => String(round(v));

/** An arc along the ring from one angle to a smaller one (left to right, clockwise on screen). */
function arc(d: Dims, from: number, to: number): string {
  const a = pointAt(d, from, d.radius);
  const b = pointAt(d, to, d.radius);
  return `M${fmt(a.x)} ${fmt(a.y)}A${d.radius} ${d.radius} 0 0 1 ${fmt(b.x)} ${fmt(b.y)}`;
}

/** The whole track, as a path. */
export function trackPath(size: GaugeSize): string {
  return arc(GAUGE_DIMS[size], Math.PI, 0);
}

/**
 * A small triangle below the ring's end, pointing down: past the scale, the ring would carry on
 * downward. A path with its numbers apart (no "x,y" pairs), so no two of them read as one number.
 */
function arrowAt(d: Dims, edge: "low" | "high"): string {
  const x = d.cx + (edge === "low" ? -d.radius : d.radius);
  const half = d.band / 2;
  const top = d.cy + 3;
  return `M${fmt(x - half)} ${fmt(top)}L${fmt(x + half)} ${fmt(top)}L${fmt(x)} ${fmt(top + half + 1)}Z`;
}

export function gaugeGeometry(r: number, ci: [number, number] | null, size: GaugeSize): GaugeGeometry {
  const d = GAUGE_DIMS[size];
  const hub = { x: d.cx, y: d.cy };
  const needle = { from: hub, to: pointAt(d, angleOf(r), d.needle), past: pastOf(r) };

  let band: GaugeGeometry["band"] = null;
  let bandPast: GaugeGeometry["bandPast"] = null;
  if (ci) {
    const [lo, hi] = ci;
    const all: Past = hi < -GAUGE_SCALE ? "low" : lo > GAUGE_SCALE ? "high" : null;
    bandPast = { low: lo < -GAUGE_SCALE, high: hi > GAUGE_SCALE, all };
    if (all === null) {
      const from = angleOf(lo);
      const to = angleOf(hi);
      const gap = d.gap / d.radius;
      band = {
        path: arc(d, from, to),
        gapPath: arc(d, Math.min(Math.PI, from + gap), Math.max(0, to - gap)),
        from: pointAt(d, from, d.radius),
        to: pointAt(d, to, d.radius),
      };
    }
  }

  const edges = new Set<"low" | "high">();
  if (needle.past) edges.add(needle.past);
  if (bandPast?.low) edges.add("low");
  if (bandPast?.high) edges.add("high");
  const arrows = (["low", "high"] as const).filter((e) => edges.has(e)).map((edge) => ({ edge, path: arrowAt(d, edge) }));

  const tick = (at: number) => {
    const a = angleOf(at);
    return { at, from: pointAt(d, a, d.radius - d.tick), to: pointAt(d, a, d.radius + d.tick) };
  };
  const below = d.cy + d.band + d.font + 2;
  return {
    dims: d,
    needle,
    band,
    bandPast,
    arrows,
    ticks: [tick(-GAUGE_SCALE), tick(0), tick(GAUGE_SCALE)],
    labels: [
      { text: "Opposite", x: d.cx - d.radius - d.tick, y: below, anchor: "start" },
      { text: "No link", x: d.cx, y: d.cy - d.radius - d.tick - 4, anchor: "middle" },
      { text: "Together", x: d.cx + d.radius + d.tick, y: below, anchor: "end" },
    ],
  };
}
