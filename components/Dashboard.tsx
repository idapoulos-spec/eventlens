import { Suspense, type ReactNode } from "react";
import { alignSeries } from "@/lib/analytics";
import { formatDateTime } from "@/lib/format";
import { getKalshiOverview, type KalshiOverview } from "@/lib/kalshi";
import { getStockOverview, type StockOverview } from "@/lib/market-data";
import type { Result } from "@/lib/result";
import { ComparisonChart } from "./charts/ComparisonChart";
import { SingleSeriesChart } from "./charts/SingleSeriesChart";
import { KalshiPanel } from "./KalshiPanel";
import { StockPanel } from "./StockPanel";
import { Card, Notice } from "./ui";

type KalshiResult = Promise<Result<KalshiOverview>>;
type StockResult = Promise<Result<StockOverview>>;

/**
 * Starts both data requests at once. Each section waits only for the data it
 * needs, so a slow Kalshi response never hides the stock data, or vice versa.
 */
export function Dashboard({ stock, kalshi }: { stock: string; kalshi: string }) {
  const kalshiData = getKalshiOverview(kalshi);
  const stockData = getStockOverview(stock);

  return (
    <div className="grid gap-5">
      <div className="grid gap-5 lg:grid-cols-2">
        <Suspense fallback={<CardSkeleton label="Loading Kalshi market" className="h-80" />}>
          <KalshiSummary data={kalshiData} />
        </Suspense>
        <Suspense fallback={<CardSkeleton label="Loading stock data" className="h-80" />}>
          <StockSummary data={stockData} />
        </Suspense>
      </div>

      <Suspense fallback={<CardSkeleton label="Loading comparison" className="h-96" />}>
        <Comparison kalshiData={kalshiData} stockData={stockData} kalshi={kalshi} stock={stock} />
      </Suspense>

      <div className="grid gap-5 lg:grid-cols-2">
        <Suspense fallback={<CardSkeleton label="Loading probability history" className="h-72" />}>
          <KalshiHistory data={kalshiData} />
        </Suspense>
        <Suspense fallback={<CardSkeleton label="Loading price history" className="h-72" />}>
          <StockHistory data={stockData} stock={stock} />
        </Suspense>
      </div>

      <Suspense fallback={null}>
        <SourcesNote kalshiData={kalshiData} stockData={stockData} />
      </Suspense>
    </div>
  );
}

async function KalshiSummary({ data }: { data: KalshiResult }) {
  const k = await data;
  if (k.ok) return <KalshiPanel data={k.data} />;
  return (
    <Card title="Kalshi">
      <Notice title="Kalshi data unavailable" message={k.error.message} />
    </Card>
  );
}

async function StockSummary({ data }: { data: StockResult }) {
  const s = await data;
  if (s.ok) return <StockPanel data={s.data} />;
  const missingKey = s.error.code === "missing_key";
  return (
    <Card title="Stock">
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
    <Card title="Event probability vs. stock" subtitle={`${kalshi} vs. ${stock} · hourly, last 7 days`}>
      {content}
    </Card>
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
    content = <SingleSeriesChart points={k.data.history} color="kalshi" label="Implied probability" format="probability" />;
  }
  return (
    <Card title="Kalshi implied probability" subtitle="Hourly midpoint, last 7 days">
      {content}
    </Card>
  );
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
        points={s.data.daily.map((b) => ({ t: b.t, value: b.close }))}
        color="stock"
        label="Close"
        format="currency"
        currency={s.data.quote.currency}
      />
    );
  }
  return (
    <Card title={`${stock} daily close`} subtitle="Last ~3 months">
      {content}
    </Card>
  );
}

async function SourcesNote({ kalshiData, stockData }: { kalshiData: KalshiResult; stockData: StockResult }) {
  const [k, s] = await Promise.all([kalshiData, stockData]);
  const fetchedAt = k.ok ? k.data.fetchedAt : s.ok ? s.data.fetchedAt : null;
  return (
    <p className="text-xs text-ink-muted">
      Sources: Kalshi public market data, Twelve Data.
      {fetchedAt !== null && ` Fetched ${formatDateTime(fetchedAt)}.`} Data may be delayed.
    </p>
  );
}

function CardSkeleton({ label, className }: { label: string; className: string }) {
  return (
    <div
      aria-busy="true"
      aria-label={label}
      className={`animate-pulse rounded-xl border border-border bg-surface ${className}`}
    />
  );
}
