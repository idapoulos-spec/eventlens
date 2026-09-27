import { alignSeries } from "@/lib/analytics";
import { formatDateTime } from "@/lib/format";
import { getKalshiOverview } from "@/lib/kalshi";
import { getStockOverview } from "@/lib/market-data";
import { ComparisonChart } from "./charts/ComparisonChart";
import { SingleSeriesChart } from "./charts/SingleSeriesChart";
import { KalshiPanel } from "./KalshiPanel";
import { StockPanel } from "./StockPanel";
import { Card, Notice } from "./ui";

export async function Dashboard({ stock, kalshi }: { stock: string; kalshi: string }) {
  const [k, s] = await Promise.all([getKalshiOverview(kalshi), getStockOverview(stock)]);

  const aligned =
    k.ok && s.ok
      ? alignSeries(
          k.data.history,
          s.data.intraday.map((b) => ({ t: b.t, value: b.close })),
        )
      : [];

  const fetchedAt = k.ok ? k.data.fetchedAt : s.ok ? s.data.fetchedAt : null;

  let comparisonNotice: string | null = null;
  if (!k.ok || !s.ok) comparisonNotice = "The comparison needs data from both Kalshi and Twelve Data.";
  else if (k.data.history.length === 0) comparisonNotice = "Kalshi has no price history for this market in the last 7 days.";
  else if (aligned.length < 2) comparisonNotice = "The Kalshi and stock histories do not overlap in time yet.";

  return (
    <div className="grid gap-5">
      <div className="grid gap-5 lg:grid-cols-2">
        {k.ok ? (
          <KalshiPanel data={k.data} />
        ) : (
          <Card title="Kalshi">
            <Notice title="Kalshi data unavailable" message={k.error.message} />
          </Card>
        )}
        {s.ok ? (
          <StockPanel data={s.data} />
        ) : (
          <Card title="Stock">
            <Notice
              tone={s.error.code === "missing_key" ? "info" : "error"}
              title={s.error.code === "missing_key" ? "Twelve Data API key not configured" : "Stock data unavailable"}
              message={s.error.message}
            />
          </Card>
        )}
      </div>

      <Card
        title="Event probability vs. stock"
        subtitle={`${kalshi} vs. ${stock} · hourly, last 7 days`}
      >
        {comparisonNotice || !s.ok ? (
          <Notice tone="info" title="Comparison unavailable" message={comparisonNotice ?? ""} />
        ) : (
          <ComparisonChart points={aligned} stockSymbol={s.data.quote.symbol} currency={s.data.quote.currency} />
        )}
      </Card>

      <div className="grid gap-5 lg:grid-cols-2">
        <Card title="Kalshi implied probability" subtitle="Hourly midpoint, last 7 days">
          {k.ok && k.data.history.length > 1 ? (
            <SingleSeriesChart
              points={k.data.history.map((p) => ({ t: p.t, value: p.value * 100 }))}
              color="kalshi"
              label="Implied probability"
              format="percent"
            />
          ) : (
            <Notice tone="info" title="No history" message="No probability history is available for this market." />
          )}
        </Card>
        <Card title={`${stock} daily close`} subtitle="Last ~3 months">
          {s.ok && s.data.daily.length > 1 ? (
            <SingleSeriesChart
              points={s.data.daily.map((b) => ({ t: b.t, value: b.close }))}
              color="stock"
              label="Close"
              format="currency"
              currency={s.data.quote.currency}
            />
          ) : (
            <Notice tone="info" title="No history" message="No stock price history is available." />
          )}
        </Card>
      </div>

      <p className="text-xs text-ink-muted">
        Sources: Kalshi public market data, Twelve Data.
        {fetchedAt !== null && ` Fetched ${formatDateTime(fetchedAt)}.`} Data may be delayed.
      </p>
    </div>
  );
}

export function DashboardSkeleton() {
  const block = "animate-pulse rounded-xl border border-border bg-surface";
  return (
    <div className="grid gap-5" aria-busy="true" aria-label="Loading market data">
      <div className="grid gap-5 lg:grid-cols-2">
        <div className={`${block} h-80`} />
        <div className={`${block} h-80`} />
      </div>
      <div className={`${block} h-96`} />
    </div>
  );
}
