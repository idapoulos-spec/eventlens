import type { ReactNode } from "react";
import { probabilityVariable } from "@/lib/analytics";
import { formatDateTime } from "@/lib/format";
import type { LongHistory, ResearchHistory } from "@/lib/history/types";
import { lastRows, marketLongRows, marketResearchRows, rowsOverlap, type LongRows } from "@/lib/history/rows";
import { STOCK_HISTORY_MS, type ResearchView } from "@/lib/history/window";
import { benchmarkFrom } from "@/lib/market-data/benchmark-series";
import type { KalshiOverview } from "@/lib/kalshi";
import type { BenchmarkSeries, StockAnalysis } from "@/lib/market-data";
import { ok, type Result } from "@/lib/result";
import { ResearchPanel } from "./research/ResearchPanel";
import { Card, Notice } from "./ui";

const SUBTITLE = "Lead-lag, rolling correlation, and an event study over 7, 30, 90, or 180 days, a year, or the market's whole life";

/** @param end where the windows end when that's a closed market's close (or, `frozen`, a frozen link's as-of time), rather than now */
export function ResearchCard({ end = null, frozen = false, children }: { end?: number | null; frozen?: boolean; children: ReactNode }) {
  return (
    <Card
      title="Research"
      subtitle={
        end === null
          ? SUBTITLE
          : `${SUBTITLE}, ending at ${frozen ? "the link’s as-of time" : "the market's close"} (${formatDateTime(end, { withYear: true })})`
      }
    >
      {children}
    </Card>
  );
}

/**
 * Lines the stock and Kalshi up at the stock's observations (top-of-hour closes during
 * trading hours, and session closes), then hands the rows to the client panel, which
 * runs the analyses for whichever window, resolution, and threshold is picked. The windows
 * end now, or, with the data store on, at a closed market's close.
 */
export async function Research({
  kalshiData,
  stockData,
  historyData,
  longData,
  benchmarkData,
  stock,
  kalshi,
  view,
}: {
  kalshiData: Promise<Result<KalshiOverview>>;
  stockData: Promise<Result<StockAnalysis>>;
  historyData: Promise<Result<ResearchHistory>>;
  /** Kalshi's history for the longer windows: the panel gets its rows after the first render. */
  longData: Promise<Result<LongHistory | null>>;
  /** The default benchmark, or null if it wasn't requested (the stock failed, or is the benchmark). */
  benchmarkData: Promise<Result<BenchmarkSeries> | null>;
  stock: string;
  kalshi: string;
  /** Where the panel opens, from the link; the default (90D, hourly) without one. */
  view?: ResearchView;
}) {
  const [k, s, h, b] = await Promise.all([kalshiData, stockData, historyData, benchmarkData]);
  const end = s.ok ? s.data.research.end : null;
  const frozen = s.ok && s.data.research.frozen === true;
  const notice = (title: string, message: string, tone: "info" | "error" = "info") => (
    <ResearchCard end={end} frozen={frozen}>
      <Notice tone={tone} title={title} message={message} />
    </ResearchCard>
  );

  if (!k.ok || !s.ok) {
    return notice("Research unavailable", "Research needs data from both Kalshi and Twelve Data.");
  }
  if (!h.ok) {
    return notice("Kalshi history failed to load", "Kalshi's 90-day price history couldn't be loaded. Please try again shortly.", "error");
  }
  if (h.data.points.length === 0) {
    const when = end === null ? "in the last 90 days" : "in the 90 days before it closed";
    return notice("Research unavailable", `Kalshi has no price history for this market ${when}.`);
  }

  const { market } = k.data;
  const closeTime = market.closeTime === null ? null : Date.parse(market.closeTime);
  const rows = marketResearchRows({
    kalshi: h.data.points,
    closeTime: Number.isFinite(closeTime) ? closeTime : null,
    research: s.data.research,
    fetchedAt: s.data.historyFetchedAt,
  });
  if (!rowsOverlap(rows)) {
    return notice("Research unavailable", "The Kalshi and stock histories don't overlap while the market was trading.");
  }
  const { hourly, daily, asOf } = lastRows(rows);
  // The longer windows' rows, streamed to the panel once Kalshi's longer history is in.
  const side = { closeTime: Number.isFinite(closeTime) ? closeTime : null, research: s.data.research, fetchedAt: s.data.historyFetchedAt };
  const long = longData.then((l): Result<LongRows | null> => (!l.ok ? l : l.data === null ? ok(null) : ok(marketLongRows({ history: l.data, ...side }))));
  const opened = market.openTime === null ? NaN : Date.parse(market.openTime);

  return (
    <ResearchPanel
      hourly={hourly}
      daily={daily}
      asOf={asOf}
      windowEnd={end}
      stockSymbol={s.data.quote.symbol || stock}
      kalshiTicker={kalshi}
      variable={probabilityVariable(market.subtitle ?? market.title)}
      // Only from where Research can read it, so a young market's page doesn't carry 540 days of the benchmark.
      initialBenchmark={b?.ok ? ok(benchmarkFrom(b.data, Math.min(s.data.research.longStart, asOf - STOCK_HISTORY_MS))) : b}
      long={long}
      opened={Number.isFinite(opened) ? opened : null}
      initialView={view}
      {...(frozen && { windowFrozen: true })}
      // Without the store a closed market's windows end now, but a frozen link's end at its close.
      {...(end === null && closeTime !== null && Number.isFinite(closeTime) && closeTime <= asOf && { closedAt: closeTime })}
    />
  );
}
