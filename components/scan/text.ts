// The scan page's wording: the baseline for its counts, which candidates move together, and where
// each result's window ended. Pure, so tests read exactly what the page says.

import { ALPHA } from "@/lib/analytics/inference";
import type { ScanCandidate } from "@/lib/scan/types";

const count = (n: number, [one, many]: [string, string]) => `${n.toLocaleString("en-US")} ${n === 1 ? one : many}`;

/** How many first-stage p-values are under 0.05, against how many chance alone would give with no relationship anywhere. */
export function chanceLine(under: number, tested: number): string {
  const expected = ALPHA * tested;
  return `p under 0.05 before any correction: ${under} of ${tested}, about ${expected.toLocaleString("en-US", { maximumFractionDigits: 1 })} expected by chance alone if none were related.`;
}

/** How many results survive each correction, and what surviving it means. */
export function survivorsLine(holm: number, bh: number): string {
  return `Survive Holm: ${holm} (the chance of any false lead in this scan is held at 5%). Survive Benjamini–Hochberg: ${bh} (on average, at most 5% of the surviving leads are false).`;
}

/**
 * Which candidates move together: the series with more than one candidate (meetings or events of
 * one series), and events with more than one outcome listed. Null when every candidate is on its own.
 */
export function correlationNote(candidates: Pick<ScanCandidate, "series" | "event">[]): string | null {
  const bySeries = new Map<string, number>();
  const byEvent = new Map<string, number>();
  for (const c of candidates) {
    if (c.series) bySeries.set(c.series, (bySeries.get(c.series) ?? 0) + 1);
    byEvent.set(c.event, (byEvent.get(c.event) ?? 0) + 1);
  }
  const series = [...bySeries].filter(([, n]) => n > 1).sort((a, b) => b[1] - a[1]);
  const events = [...byEvent].filter(([, n]) => n > 1);
  if (series.length === 0 && events.length === 0) return null;
  const parts: string[] = [];
  if (series.length > 0) {
    const listed = series.slice(0, 3).map(([s, n]) => `${n} of ${candidates.length} are in ${s}`);
    parts.push(`${listed.join("; ")}${series.length > 3 ? `; and ${series.length - 3} more series hold several` : ""}.`);
  }
  if (events.length > 0) parts.push(`${count(events.length, ["event has", "events have"])} more than one outcome listed, and outcomes of one event are near-duplicates.`);
  return `${parts.join(" ")} Candidates in the same series or event tend to move together, so their results are correlated: several similar results there are not independent confirmations.`;
}

export const WINNERS_CURSE =
  "The top-ranked effects are likely overstated (the winner’s curse): they rank first partly because chance pushed them up, so expect smaller effects when they are tested again on new data.";

export const SCOPE_NOTE =
  "The corrections cover this scan only. Choosing the list after seeing results, or running several scans (other stocks, windows, or lists) and keeping the best, is not corrected for.";

/** The median of |r| over the tested candidates: what a typical result looks like, next to the top ones. */
export function medianAbs(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = values.map(Math.abs).sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}
