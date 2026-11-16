// The gauge as SVG markup, from its geometry (gauge.ts): one renderer for the card on the page and for
// a printable report, so both draw the same thing; only the palette differs (the app's tokens on the
// page, the report's light colors in print). Its numbers go in only as coordinates; its one text that
// isn't a fixed label, the screen reader's label, is escaped.

import { escapeHtml } from "@/lib/report/html";
import { gaugeGeometry, trackPath, type GaugeSize } from "./gauge";
import type { DrawnGauge } from "./summary";

export interface GaugePalette {
  /** The needle, the band, and the arrows: the correlation teal. */
  teal: string;
  /** The ring under the band: a recessive gray. */
  track: string;
  /** The ticks and labels: a text color. */
  ink: string;
  /** The card's color, for the gap around the band, the needle, and the ticks. */
  surface: string;
}

/** The app's tokens, on a card of either surface. */
export const pagePalette = (surface: "var(--surface)" | "var(--surface-raised)"): GaugePalette => ({
  teal: "var(--series-correlation)",
  track: "var(--axis)",
  ink: "var(--ink-secondary)",
  surface,
});

/** Extra attributes on the <svg>: a report's adds a title, a background, its font, and a width cap. */
export interface SvgFrame {
  background: boolean;
  title: boolean;
  attributes: string;
}

const PAGE_FRAME: SvgFrame = { background: false, title: false, attributes: 'class="block h-auto w-full"' };

export function gaugeSvg(gauge: DrawnGauge, size: GaugeSize, palette: GaugePalette, frame: SvgFrame = PAGE_FRAME): string {
  const g = gaugeGeometry(gauge.r, gauge.ci, size);
  const d = g.dims;
  const label = escapeHtml(gauge.label);
  const line = (a: { x: number; y: number }, b: { x: number; y: number }, attrs: string) => `<line x1="${a.x}" y1="${a.y}" x2="${b.x}" y2="${b.y}" ${attrs}/>`;
  const parts: string[] = [];
  if (frame.background) parts.push(`<rect width="${d.width}" height="${d.height}" fill="${palette.surface}"/>`);
  parts.push(`<path d="${trackPath(size)}" fill="none" stroke="${palette.track}" stroke-width="${d.track}" data-part="track"/>`);
  if (g.band) {
    // A gap of the card's color at each end, so the band never touches the track (the report's teal is only 2.6:1 on its gray).
    parts.push(`<path d="${g.band.gapPath}" fill="none" stroke="${palette.surface}" stroke-width="${d.band}"/>`);
    parts.push(`<path d="${g.band.path}" fill="none" stroke="${palette.teal}" stroke-width="${d.band}" data-part="band"/>`);
  }
  for (const t of g.ticks) {
    parts.push(line(t.from, t.to, `stroke="${palette.surface}" stroke-width="5"`));
    parts.push(line(t.from, t.to, `stroke="${palette.ink}" stroke-width="2" data-part="tick"`));
  }
  for (const a of g.arrows) parts.push(`<path d="${a.path}" fill="${palette.teal}" data-part="arrow-${a.edge}"/>`);
  const { from, to } = g.needle;
  parts.push(line(from, to, `stroke="${palette.surface}" stroke-width="6.5" stroke-linecap="round"`));
  parts.push(line(from, to, `stroke="${palette.teal}" stroke-width="2.5" stroke-linecap="round" data-part="needle"`));
  parts.push(`<circle cx="${d.cx}" cy="${d.cy}" r="4" fill="${palette.teal}" stroke="${palette.surface}" stroke-width="2"/>`);
  for (const l of g.labels) parts.push(`<text x="${l.x}" y="${l.y}" text-anchor="${l.anchor}" font-size="${d.font}" fill="${palette.ink}">${l.text}</text>`);
  const title = frame.title ? `<title>${label}</title>` : "";
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${d.width} ${d.height}" role="img" aria-label="${label}" data-gauge="${size}" ${frame.attributes}>${title}${parts.join("")}</svg>`;
}
