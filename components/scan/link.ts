// The scan page's links: every setting of its form, so a link opens the same scan (it runs only
// when asked, since it spends credits), and a finished scan's frozen link, which names the
// candidates it tested and ends their windows at its as-of time. Pure, so tests read exactly the links.

import type { Resolution } from "@/lib/analytics/research";
import { formatAsOf, parseAsOf, WINDOWS, type WindowChoice } from "@/lib/history/window";
import { parseSeries, parseTickers } from "@/lib/scan/api";
import type { ScanCandidate } from "@/lib/scan/types";
import { validateStockTicker } from "@/lib/validation";
import type { Result } from "@/lib/result";

export type Source = "series" | "stored" | "tickers";

/** What the form asks for. */
export interface ScanLink {
  stock: string;
  source: Source;
  /** The series (series scope, and optionally stored). */
  series: string;
  /** With a series: its stored settled events too. */
  settled: boolean;
  /** A custom list, one ticker per line. */
  tickers: string;
  window: WindowChoice;
  resolution: Resolution;
  /** Windows still open then end here (ms); null: now. */
  asOf: number | null;
}

export const DEFAULT_SCAN: ScanLink = { stock: "", source: "series", series: "KXFEDDECISION", settled: false, tickers: "", window: 90, resolution: "hourly", asOf: null };

/** /scan?… for these settings, each left out at its default. */
export function scanHref(link: ScanLink): string {
  const params = new URLSearchParams();
  if (link.stock) params.set("stock", link.stock);
  if (link.source !== DEFAULT_SCAN.source) params.set("source", link.source);
  if (link.source !== "tickers" && link.series && link.series !== DEFAULT_SCAN.series) params.set("series", link.series);
  if (link.source === "stored" && !link.series) params.set("series", "");
  if (link.source === "series" && link.settled) params.set("settled", "1");
  const tickers = link.tickers.split(/[\s,]+/).filter(Boolean);
  if (link.source === "tickers" && tickers.length > 0) params.set("tickers", tickers.join(","));
  if (link.window !== DEFAULT_SCAN.window) params.set("window", String(link.window));
  if (link.resolution !== DEFAULT_SCAN.resolution) params.set("res", link.resolution);
  if (link.asOf !== null) params.set("asof", formatAsOf(link.asOf));
  const query = params.toString();
  return query ? `/scan?${query}` : "/scan";
}

/**
 * The settings a /scan link carries; each one it can't read is left at its default, except an
 * as-of time it can't read, which is an error (so a frozen link never quietly runs live).
 */
export function parseScanLink(get: (name: string) => string | null | undefined, now: number): { link: ScanLink; asOf: Result<number | null> } {
  const stock = validateStockTicker(get("stock"));
  const sourceParam = get("source");
  const source: Source = sourceParam === "stored" || sourceParam === "tickers" ? sourceParam : "series";
  const rawSeries = get("series");
  const series = rawSeries === null || rawSeries === undefined ? null : rawSeries === "" ? { ok: true as const, value: "" } : parseSeries(rawSeries);
  const tickers = get("tickers") ? parseTickers(get("tickers")!) : null;
  const window = WINDOWS.find((w) => String(w) === get("window")) ?? DEFAULT_SCAN.window;
  const res = get("res");
  const asOf = parseAsOf(get("asof"), now);
  return {
    link: {
      stock: stock.ok ? stock.value : "",
      source,
      // Absent: the default series; empty (stored events only): every stored event.
      series: series?.ok ? series.value : DEFAULT_SCAN.series,
      settled: source === "series" && get("settled") === "1",
      tickers: tickers?.ok ? tickers.value.join("\n") : "",
      window,
      resolution: window === 7 ? "hourly" : res === "daily" ? "daily" : "hourly",
      asOf: asOf.ok ? asOf.data : null,
    },
    asOf,
  };
}

/**
 * A finished scan's frozen link: its candidates as a custom list (an event's stand-in outcome as
 * its own market), the same window and resolution, and its as-of time (the scan's own, or when its
 * prices were fetched, where its open candidates' windows ended).
 */
export function frozenScanHref({ stock, candidates, window, resolution, asOf }: { stock: string; candidates: Pick<ScanCandidate, "ticker">[]; window: WindowChoice; resolution: Resolution; asOf: number }): string {
  return scanHref({ ...DEFAULT_SCAN, stock, source: "tickers", tickers: candidates.map((c) => c.ticker).join("\n"), window, resolution, asOf });
}
