import type { GaugeSize } from "./gauge";
import { gaugeSvg, pagePalette } from "./gaugeSvg";
import type { DrawnGauge } from "./summary";

/**
 * The gauge's drawing on the page: the same markup a report prints (gaugeSvg.ts), in the app's colors.
 * The <svg> is one image to a screen reader (role="img"), its label the direction, r, and the range in
 * words; the line and note beside it are text.
 */
export function GaugeDrawing({ gauge, size, surface, className }: { gauge: DrawnGauge; size: GaugeSize; surface: "var(--surface)" | "var(--surface-raised)"; className: string }) {
  return <div className={className} dangerouslySetInnerHTML={{ __html: gaugeSvg(gauge, size, pagePalette(surface)) }} />;
}
