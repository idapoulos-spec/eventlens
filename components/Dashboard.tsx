import { Suspense, type ReactNode } from "react";
import { alignSeries } from "@/lib/analytics";
import { formatDateTime } from "@/lib/format";
import { getKalshiOverview, type KalshiOverview } from "@/lib/kalshi";
import { getStockOverview, type StockOverview } from "@/lib/market-data";
import type { Result } from "@/lib/result";
import { ComparisonChart } from "./charts/ComparisonChart";
import { SingleSeriesChart } from "./charts/SingleSeriesChart";
import { tradingDayClose } from "./charts/time";
import { KalshiPanel } from "./KalshiPanel";
import { StockPanel } from "./StockPanel";
import { Card, Notice } from "./ui";

type KalshiResult = Promise<Result<KalshiOverview>>;
type StockResult = Promise<Result<StockOverview>>;

/**
 * Starts both data requests at once. Each section waits only for the data it
 * needs, so a slow Kalshi response never hides the stock data, or vice versa.
 * While a section loads, its card already shows its title, and a placeholder
 * the size of its content, so the page doesn't jump as sections arrive.
 */
export function Dashboard({ stock, kalshi }: { stock: string; kalshi: string }) {
  const kalshiData = getKalshiOverview(kalshi);
  const stockData = getStockOverview(stock);

  return (
    <div className="grid gap-4 sm:gap-5">
      <div className="grid gap-4 sm:gap-5 lg:grid-cols-2">
        <Suspense fallback={<PanelSkeleton title={<KalshiTitle ticker={kalshi} />} label="Loading Kalshi market" stats={8} />}>
          <KalshiSummary data={kalshiData} ticker={kalshi} />
        </Suspense>
        <Suspense fallback={<PanelSkeleton title={<StockTitle symbol={stock} />} label="Loading stock data" stats={4} />}>
          <StockSummary data={stockData} symbol={stock} />
        </Suspense>
      </div>

      <Suspense
        fallback={
          <ComparisonCard kalshi={kalshi} stock={stock}>
            <ComparisonSkeleton />
          </ComparisonCard>
        }
      >
        <Comparison kalshiData={kalshiData} stockData={stockData} kalshi={kalshi} stock={stock} />
      </Suspense>

      <div className="grid gap-4 sm:gap-5 lg:grid-cols-2">
        <Suspense
          fallback={
            <KalshiHistoryCard>
              <ChartSkeleton label="Loading probability history" className="h-64" />
            </KalshiHistoryCard>
          }
        >
          <KalshiHistory data={kalshiData} />
        </Suspense>
        <Suspense
          fallback={
            <StockHistoryCard stock={stock}>
              <ChartSkeleton label="Loading price history" className="h-64" />
            </StockHistoryCard>
          }
        >
          <StockHistory data={stockData} stock={stock} />
        </Suspense>
      </div>

      <Suspense fallback={null}>
        <SourcesNote kalshiData={kalshiData} stockData={stockData} />
      </Suspense>
    </div>
  );
}

// ---- Card titles, shared by each section's loading, error, and loaded states ----

function KalshiTitle({ ticker }: { ticker: string }) {
  return (
    <span className="flex items-center gap-2">
      <span aria-hidden className="h-2.5 w-2.5 rounded-full bg-series-kalshi" />
      Kalshi · <span className="font-mono">{ticker}</span>
    </span>
  );
}

function StockTitle({ symbol }: { symbol: string }) {
  return (
    <span className="flex items-center gap-2">
      <span aria-hidden className="h-2.5 w-2.5 rounded-full bg-series-stock" />
      Stock · <span className="font-mono">{symbol}</span>
    </span>
  );
}

function ComparisonCard({ kalshi, stock, children }: { kalshi: string; stock: string; children: ReactNode }) {
  return (
    <Card title="Event probability vs. stock" subtitle={`${kalshi} vs. ${stock} · hourly, last 7 days`}>
      {children}
    </Card>
  );
}

// History points are estimated like the headline probability: the bid/ask midpoint,
// or the last trade when one side of the book is empty.
function KalshiHistoryCard({ children }: { children: ReactNode }) {
  return (
    <Card title="Kalshi implied probability" subtitle="Hourly, last 7 days · midpoint, or last trade when the book is one-sided">
      {children}
    </Card>
  );
}

// Completed sessions only: while the market is open, today's bar is still forming (see getStockOverview).
function StockHistoryCard({ stock, children }: { stock: string; children: ReactNode }) {
  return (
    <Card title={`${stock} daily close`} subtitle="Last ~3 months · completed sessions">
      {children}
    </Card>
  );
}

// ---- Sections ----

async function KalshiSummary({ data, ticker }: { data: KalshiResult; ticker: string }) {
  const k = await data;
  if (k.ok) return <KalshiPanel data={k.data} />;
  return (
    <Card title={<KalshiTitle ticker={ticker} />}>
      <Notice title="Kalshi data unavailable" message={k.error.message} />
    </Card>
  );
}

async function StockSummary({ data, symbol }: { data: StockResult; symbol: string }) {
  const s = await data;
  if (s.ok) return <StockPanel data={s.data} />;
  const missingKey = s.error.code === "missing_key";
  return (
    <Card title={<StockTitle symbol={symbol} />}>
      <Notice
        tone={missingKey ? "info" : "error"}
        title={missingKey ? "Stock data not set up" : "Stock data unavailable"}
        message={s.error.message}
      />
    </Card>
  );
}

async function Comparison({
  kalshiData,
  stockData,
  kalshi,
  stock,
}: {
  kalshiData: KalshiResult;
  stockData: StockResult;
  kalshi: string;
  stock: string;
}) {
  const [k, s] = await Promise.all([kalshiData, stockData]);
  const card = (content: ReactNode) => (
    <ComparisonCard kalshi={kalshi} stock={stock}>
      {content}
    </ComparisonCard>
  );

  if (!k.ok || !s.ok) {
    return card(<Notice tone="info" title="Comparison unavailable" message="The comparison needs data from both Kalshi and Twelve Data." />);
  }
  if (k.data.history === null) {
    return card(
      <Notice title="Kalshi history failed to load" message="Kalshi's price history couldn't be loaded, so there's nothing to compare yet. Please try again shortly." />,
    );
  }
  if (k.data.history.length === 0) {
    return card(<Notice tone="info" title="Comparison unavailable" message="Kalshi has no price history for this market in the last 7 days." />);
  }
  const aligned = alignSeries(
    k.data.history,
    s.data.intraday.map((b) => ({ t: b.t, value: b.close })),
  );
  if (aligned.length < 2) {
    return card(<Notice tone="info" title="Comparison unavailable" message="The Kalshi and stock histories do not overlap in time yet." />);
  }
  return card(<ComparisonChart points={aligned} stockSymbol={s.data.quote.symbol} currency={s.data.quote.currency} />);
}

async function KalshiHistory({ data }: { data: KalshiResult }) {
  const k = await data;
  let content: ReactNode;
  if (!k.ok) {
    content = <Notice title="History unavailable" message="Kalshi market data couldn't be loaded, so there's no history to show." />;
  } else if (k.data.history === null) {
    content = <Notice title="History failed to load" message="Kalshi's price history couldn't be loaded. Please try again shortly." />;
  } else if (k.data.history.length <= 1) {
    content = <Notice tone="info" title="No history" message="This market has no recorded prices in the last 7 days." />;
  } else {
    content = <SingleSeriesChart points={k.data.history} color="kalshi" label="Implied probability" format="probability" cadence="hourly" />;
  }
  return <KalshiHistoryCard>{content}</KalshiHistoryCard>;
}

async function StockHistory({ data, stock }: { data: StockResult; stock: string }) {
  const s = await data;
  let content: ReactNode;
  if (!s.ok) {
    content =
      s.error.code === "missing_key" ? (
        <Notice tone="info" title="No history" message="Stock price history isn't available because this site has no market-data API key set up." />
      ) : (
        <Notice title="History unavailable" message="Stock data couldn't be loaded, so there's no price history to show." />
      );
  } else if (s.data.daily.length <= 1) {
    content = <Notice tone="info" title="No history" message={`Twelve Data has no daily price history for ${stock}.`} />;
  } else {
    content = (
      <SingleSeriesChart
        // Daily bars are stamped at 00:00 UTC, the previous evening in New York; move
        // each to its trading date's close so New York-time axes show the right day.
        points={s.data.daily.map((b) => ({ t: tradingDayClose(b.t), value: b.close }))}
        color="stock"
        label="Close"
        format="currency"
        currency={s.data.quote.currency}
        cadence="daily"
      />
    );
  }
  return <StockHistoryCard stock={stock}>{content}</StockHistoryCard>;
}

async function SourcesNote({ kalshiData, stockData }: { kalshiData: KalshiResult; stockData: StockResult }) {
  const [k, s] = await Promise.all([kalshiData, stockData]);
  const fetchedAt = k.ok ? k.data.fetchedAt : s.ok ? s.data.fetchedAt : null;
  return (
    <p className="text-xs text-ink-muted">
      Sources: Kalshi public market data, Twelve Data.
      {fetchedAt !== null && ` Fetched ${formatDateTime(fetchedAt)}.`} All times are New York time. Data may be delayed.
    </p>
  );
}

// ---- Loading placeholders ----

const PULSE = "animate-pulse motion-reduce:animate-none";

/** A placeholder line of text or a value; a span so it can sit inside a card's subtitle. */
function Bar({ className }: { className: string }) {
  return <span aria-hidden className={`block rounded bg-surface-raised ${PULSE} ${className}`} />;
}

/** Mirrors the Kalshi and stock panels: name, headline figure, then a grid of stats. */
function PanelSkeleton({ title, label, stats }: { title: ReactNode; label: string; stats: number }) {
  return (
    <Card title={title} subtitle={<Bar className="mt-1.5 h-3 w-44" />}>
      <div role="status">
        <span className="sr-only">{label}…</span>
        <Bar className="h-5 w-full max-w-md" />
        <Bar className="mt-1.5 h-5 w-3/5 max-w-xs" />
        <Bar className="mt-2 h-4 w-2/5" />
        <div className="mt-5 grid grid-cols-2 gap-x-6 gap-y-5 sm:grid-cols-3">
          <div className="col-span-2 sm:col-span-3">
            <Bar className="h-3 w-28" />
            <Bar className="mt-2 h-8 w-32" />
            <Bar className="mt-2 h-3 w-40" />
          </div>
          {Array.from({ length: stats }, (_, i) => (
            <div key={i}>
              <Bar className="h-3 w-16" />
              <Bar className="mt-2 h-6 w-20" />
              <Bar className="mt-1.5 h-3 w-24" />
            </div>
          ))}
        </div>
      </div>
    </Card>
  );
}

/** A chart-sized placeholder with faint gridlines and a visible label. */
function ChartSkeleton({ label, className }: { label: string; className: string }) {
  return (
    <div role="status" className={`relative overflow-hidden rounded-lg ${className}`}>
      <div
        aria-hidden
        className={`absolute inset-0 bg-[linear-gradient(to_bottom,var(--grid)_1px,transparent_1px)] bg-size-[100%_25%] ${PULSE}`}
      />
      <span className="absolute inset-0 flex items-center justify-center">
        <span className="rounded bg-surface px-2 text-xs text-ink-muted">{label}…</span>
      </span>
    </div>
  );
}

/** Mirrors ComparisonChart: legend and view toggle, chart, then the footnote. */
function ComparisonSkeleton() {
  return (
    <div>
      <div className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex gap-4">
          <Bar className="h-4 w-44" />
          <Bar className="h-4 w-28" />
        </div>
        <Bar className="h-10 w-full sm:h-8 sm:w-52" />
      </div>
      <ChartSkeleton label="Loading 7-day comparison" className="h-72 sm:h-80" />
      <Bar className="mt-3 h-3 w-full max-w-xl" />
      <Bar className="mt-1.5 h-3 w-2/3 max-w-sm" />
    </div>
  );
}
