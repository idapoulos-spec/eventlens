import type { ReactNode } from "react";
import { probabilityVariable } from "@/lib/analytics";
import { formatDateTime } from "@/lib/format";
import type { ResearchHistory } from "@/lib/history/types";
import { lastRows, marketResearchRows, rowsOverlap } from "@/lib/history/rows";
import type { KalshiOverview } from "@/lib/kalshi";
import type { BenchmarkSeries, StockAnalysis } from "@/lib/market-data";
import type { Result } from "@/lib/result";
import { ResearchPanel } from "./research/ResearchPanel";
import { Card, Notice } from "./ui";

const SUBTITLE = "Lead-lag, rolling correlation, and an event study over 7, 30, or 90 days";

/** @param end where the windows end when that's a closed market's close, rather than now */
export function ResearchCard({ end = null, children }: { end?: number | null; children: ReactNode }) {
  return (
    <Card
      title="Research"
      subtitle={end === null ? SUBTITLE : `${SUBTITLE}, ending at the market's close (${formatDateTime(end, { withYear: true })})`}
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
  benchmarkData,
  stock,
  kalshi,
}: {
  kalshiData: Promise<Result<KalshiOverview>>;
  stockData: Promise<Result<StockAnalysis>>;
  historyData: Promise<Result<ResearchHistory>>;
  /** The default benchmark, or null if it wasn't requested (the stock failed, or is the benchmark). */
  benchmarkData: Promise<Result<BenchmarkSeries> | null>;
  stock: string;
  kalshi: string;
}) {
  const [k, s, h, b] = await Promise.all([kalshiData, stockData, historyData, benchmarkData]);
  const end = s.ok ? s.data.research.end : null;
  const notice = (title: string, message: string, tone: "info" | "error" = "info") => (
    <ResearchCard end={end}>
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

  return (
    <ResearchPanel
      hourly={hourly}
      daily={daily}
      asOf={asOf}
      windowEnd={end}
      stockSymbol={s.data.quote.symbol || stock}
      kalshiTicker={kalshi}
      variable={probabilityVariable(market.subtitle ?? market.title)}
      initialBenchmark={b}
    />
  );
}
