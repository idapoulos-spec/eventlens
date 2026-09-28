import { DISPLAY_TIME_ZONE } from "@/lib/format";
// Imported directly: the lib/market-data index also loads the server-only Twelve Data client.
import { timeZoneOffsetMs } from "@/lib/market-data/session";
import { computeChanges } from "./changes";
import type { ResearchRow, Resolution } from "./research";

export const RESEARCH_CSV_COLUMNS = [
  "timestamp_utc",
  "timestamp_ny",
  "resolution",
  "stock_close",
  "kalshi_probability",
  "kalshi_source",
  "kalshi_as_of_utc",
  "kalshi_valid",
  "kalshi_exclusion",
  "interval_valid",
  "interval_exclusion",
  "prob_change_pp",
  "stock_log_return",
] as const;

type Cell = string | number | boolean | null;

/** One CSV field (RFC 4180): quoted only when it contains a comma, quote, or line break. */
export function csvField(value: Cell): string {
  if (value === null) return "";
  const s = String(value);
  return /[",\r\n]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s;
}

const isoUtc = (ms: number) => new Date(ms).toISOString().replace(".000Z", "Z");

/** ISO 8601 in New York time with its UTC offset, e.g. 2026-09-28T10:00:00-04:00. */
function isoNewYork(ms: number): string {
  const offset = timeZoneOffsetMs(ms, DISPLAY_TIME_ZONE);
  const local = new Date(ms + offset).toISOString().slice(0, 19);
  const minutes = Math.abs(offset) / 60_000;
  const hh = String(Math.floor(minutes / 60)).padStart(2, "0");
  const mm = String(minutes % 60).padStart(2, "0");
  return `${local}${offset < 0 ? "-" : "+"}${hh}:${mm}`;
}

/**
 * The aligned research dataset as CSV: every row, including excluded ones with the
 * reason, so the analysis can be redone or filtered differently elsewhere. The change
 * columns describe the interval ending at each row. Numbers are unrounded; missing
 * values are empty.
 */
export function researchCsv(rows: ResearchRow[], resolution: Resolution): string {
  const { intervals } = computeChanges(rows);
  const lines = [RESEARCH_CSV_COLUMNS.join(",")];
  rows.forEach((row, i) => {
    const interval = intervals[i];
    const cells: Cell[] = [
      isoUtc(row.t),
      isoNewYork(row.t),
      resolution,
      row.stockClose,
      row.probability,
      row.kalshiSource,
      row.kalshiAsOf === null ? null : isoUtc(row.kalshiAsOf),
      row.exclusion === null,
      row.exclusion,
      interval.exclusion === null,
      interval.exclusion,
      interval.probChangePp,
      interval.logReturn,
    ];
    lines.push(cells.map(csvField).join(","));
  });
  return `${lines.join("\r\n")}\r\n`;
}
