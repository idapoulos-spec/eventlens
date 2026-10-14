// The part of a step series a chart window shows. Pure, so it's tested directly.

/**
 * Points from `from` on. A series sent as changes only holds each value until the next point, so
 * the value in effect at `from` (the last point before it) starts the window, moved to `from`.
 */
export function windowed<P extends { t: number }>(points: P[], from: number): P[] {
  const i = points.findIndex((p) => p.t >= from);
  if (i === -1) return points.length > 0 ? [{ ...points[points.length - 1], t: from }] : [];
  if (i === 0 || points[i].t === from) return points.slice(i);
  return [{ ...points[i - 1], t: from }, ...points.slice(i)];
}
