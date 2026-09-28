import { Dashboard } from "@/components/Dashboard";
import { Disclaimer } from "@/components/Disclaimer";
import { TickerForm } from "@/components/TickerForm";
import { Notice } from "@/components/ui";
import { ANALYSIS_LIMIT_SUMMARY, checkAnalysisRateLimit } from "@/lib/analysis-rate-limit";
import { formatWait } from "@/lib/format";
import { validateKalshiTicker, validateStockTicker } from "@/lib/validation";

// Cap on how long Vercel lets this page's server function run. The worst case is about
// 6 seconds: every Kalshi and Twelve Data request starts at once, each with a 6-second timeout.
export const maxDuration = 30;

const first = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);

export default async function Home({ searchParams }: PageProps<"/">) {
  const params = await searchParams;
  const rawStock = first(params.stock);
  const rawKalshi = first(params.kalshi);
  const hasQuery = rawStock !== undefined || rawKalshi !== undefined;

  const stock = validateStockTicker(rawStock);
  const kalshi = validateKalshiTicker(rawKalshi);
  // Only valid analyses reach the upstream APIs, so only they count against the limit.
  const rateLimit = stock.ok && kalshi.ok ? await checkAnalysisRateLimit() : { ok: true as const };

  return (
    <div className="mx-auto w-full max-w-6xl flex-1 px-4 py-6 sm:px-6 sm:py-8 lg:py-10">
      <header className="mb-5 sm:mb-6">
        <h1 className="flex items-center gap-2.5 text-2xl font-semibold tracking-tight">
          <LogoMark />
          EventLens
        </h1>
        <p className="mt-1 text-sm text-ink-secondary">
          Compare Kalshi prediction-market probabilities with stock-market data.
        </p>
      </header>

      <div className="mb-5 rounded-xl border border-border bg-surface p-4 sm:mb-6 sm:p-5">
        <TickerForm
          initialStock={stock.ok ? stock.value : (rawStock ?? "")}
          initialKalshi={kalshi.ok ? kalshi.value : (rawKalshi ?? "")}
        />
      </div>

      {!hasQuery ? (
        <EmptyState />
      ) : !stock.ok || !kalshi.ok ? (
        <Notice title="Invalid input" message={!stock.ok ? stock.message : !kalshi.ok ? kalshi.message : ""} />
      ) : !rateLimit.ok ? (
        <Notice
          tone="info"
          title="Too many analyses"
          message={`To protect the shared market-data quota, each visitor can run ${ANALYSIS_LIMIT_SUMMARY}. Try again in ${formatWait(rateLimit.retryAfterSec)}.`}
        />
      ) : (
        // The key remounts the dashboard for each new analysis, so every section shows its loading state again.
        <Dashboard key={`${stock.value}|${kalshi.value}`} stock={stock.value} kalshi={kalshi.value} />
      )}

      <footer className="mt-10 border-t border-border pt-4">
        <Disclaimer />
      </footer>
    </div>
  );
}

/** Two overlapping dots in the series colors: the Kalshi and stock lines on every chart. */
function LogoMark() {
  return (
    <svg aria-hidden viewBox="0 0 24 16" className="h-4 w-6 shrink-0">
      <circle cx="8" cy="8" r="7" fill="var(--series-kalshi)" />
      <circle cx="16" cy="8" r="7" fill="var(--series-stock)" fillOpacity="0.85" />
    </svg>
  );
}

const FEATURES = [
  {
    dot: "bg-series-kalshi",
    title: "Kalshi market",
    text: "Implied probability, bid and ask, 1h and 24h change, and an uncertainty score.",
  },
  {
    dot: "bg-series-stock",
    title: "Stock",
    text: "Price, daily change, volume (compared with average after the close), and 30-day realized volatility.",
  },
  {
    dot: "bg-linear-to-r from-series-kalshi from-50% to-series-stock to-50%",
    title: "Comparison",
    text: "Probability change against stock return, hour by hour over the last 7 days.",
  },
];

function EmptyState() {
  return (
    <section className="rounded-xl border border-dashed border-border px-5 py-7 sm:px-8 sm:py-9">
      <h2 className="text-sm font-semibold text-ink">Pick a stock and a Kalshi market to compare</h2>
      <p className="mt-1.5 max-w-2xl text-sm text-ink-secondary">
        Market tickers appear in Kalshi market URLs and look like{" "}
        <span className="font-mono break-all text-ink">KXFEDDECISION-26OCT-H25</span>. Use a market ticker, not an
        event or series ticker.
      </p>
      <ul className="mt-6 grid gap-5 sm:grid-cols-3 sm:gap-6">
        {FEATURES.map((f) => (
          <li key={f.title}>
            <p className="flex items-center gap-2 text-xs font-medium uppercase tracking-wider text-ink-muted">
              <span aria-hidden className={`h-2 w-2 rounded-full ${f.dot}`} />
              {f.title}
            </p>
            <p className="mt-1.5 text-sm text-ink-secondary">{f.text}</p>
          </li>
        ))}
      </ul>
    </section>
  );
}
