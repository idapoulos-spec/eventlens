import type { ReactNode } from "react";
import { buildResearchRows, rowsSince } from "@/lib/analytics";
import { formatDateTime } from "@/lib/format";
import type { ResearchHistory } from "@/lib/history/types";
import { RESEARCH_WINDOW_MS, researchStockPoints } from "@/lib/history/window";
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
  const common = { kalshi: h.data.points, closeTime: Number.isFinite(closeTime) ? closeTime : null };
  // When the bars were fetched: bars that hadn't closed by then may still have been forming.
  const fetchedAt = s.data.historyFetchedAt;
  // Windows count back from here.
  const asOf = end ?? fetchedAt;
  const from = asOf - RESEARCH_WINDOW_MS;
  const stockPoints = researchStockPoints({ ...s.data.research, fetchedAt });

  const hourly = buildResearchRows({ ...common, stock: stockPoints.hourly, resolution: "hourly" });
  const daily = buildResearchRows({ ...common, stock: stockPoints.daily, resolution: "daily" });

  if (!hourly.some((r) => r.exclusion === null) && !daily.some((r) => r.exclusion === null)) {
    return notice("Research unavailable", "The Kalshi and stock histories don't overlap while the market was trading.");
  }

  return (
    <ResearchPanel
      hourly={rowsSince(hourly, from)}
      daily={rowsSince(daily, from)}
      asOf={asOf}
      windowEnd={end}
      stockSymbol={s.data.quote.symbol || stock}
      kalshiTicker={kalshi}
      yesLabel={market.subtitle ?? market.title}
      initialBenchmark={b}
    />
  );
}
