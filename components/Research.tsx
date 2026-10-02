import type { ReactNode } from "react";
import { buildResearchRows, rowsSince, topOfHourCloses } from "@/lib/analytics";
import type { KalshiOverview, KalshiPoint } from "@/lib/kalshi";
import type { BenchmarkSeries, StockOverview } from "@/lib/market-data";
// Imported directly: the lib/market-data index also loads the server-only Twelve Data client.
import { sessionClosePoints } from "@/lib/market-data/session";
import type { Result } from "@/lib/result";
import { ResearchPanel } from "./research/ResearchPanel";
import { Card, Notice } from "./ui";

const DAY_MS = 24 * 60 * 60 * 1000;
// The longest research window the panel offers.
const MAX_WINDOW_DAYS = 90;

export function ResearchCard({ children }: { children: ReactNode }) {
  return (
    <Card title="Research" subtitle="Lead-lag, rolling correlation, and an event study over 7, 30, or 90 days">
      {children}
    </Card>
  );
}

/**
 * Lines the stock and Kalshi up at the stock's observations (top-of-hour closes during
 * trading hours, and session closes), then hands the rows to the client panel, which
 * runs the analyses for whichever window, resolution, and threshold is picked.
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
  stockData: Promise<Result<StockOverview>>;
  historyData: Promise<Result<KalshiPoint[]>>;
  /** The default benchmark, or null if it wasn't requested (the stock failed, or is the benchmark). */
  benchmarkData: Promise<Result<BenchmarkSeries> | null>;
  stock: string;
  kalshi: string;
}) {
  const [k, s, h, b] = await Promise.all([kalshiData, stockData, historyData, benchmarkData]);
  const notice = (title: string, message: string, tone: "info" | "error" = "info") => (
    <ResearchCard>
      <Notice tone={tone} title={title} message={message} />
    </ResearchCard>
  );

  if (!k.ok || !s.ok) {
    return notice("Research unavailable", "Research needs data from both Kalshi and Twelve Data.");
  }
  if (!h.ok) {
    return notice("Kalshi history failed to load", "Kalshi's 90-day price history couldn't be loaded. Please try again shortly.", "error");
  }
  if (h.data.length === 0) {
    return notice("Research unavailable", "Kalshi has no price history for this market in the last 90 days.");
  }

  const { market } = k.data;
  const closeTime = market.closeTime === null ? null : Date.parse(market.closeTime);
  const common = { kalshi: h.data, closeTime: Number.isFinite(closeTime) ? closeTime : null };
  // When the bars were fetched: bars that hadn't closed by then may still have been forming.
  const asOf = s.data.historyFetchedAt;
  const from = asOf - MAX_WINDOW_DAYS * DAY_MS;

  const hourly = buildResearchRows({
    ...common,
    stock: topOfHourCloses(
      s.data.halfHourly.map((b) => ({ t: b.t, value: b.close })),
      asOf,
    ),
    resolution: "hourly",
  });
  // Each session's real close, so early-close days line up with Kalshi at the right moment.
  const daily = buildResearchRows({
    ...common,
    stock: sessionClosePoints(s.data.daily, s.data.halfHourly),
    resolution: "daily",
  });

  if (!hourly.some((r) => r.exclusion === null) && !daily.some((r) => r.exclusion === null)) {
    return notice("Research unavailable", "The Kalshi and stock histories don't overlap while the market was trading.");
  }

  return (
    <ResearchPanel
      hourly={rowsSince(hourly, from)}
      daily={rowsSince(daily, from)}
      asOf={asOf}
      stockSymbol={s.data.quote.symbol || stock}
      kalshiTicker={kalshi}
      yesLabel={market.subtitle ?? market.title}
      initialBenchmark={b}
    />
  );
}
