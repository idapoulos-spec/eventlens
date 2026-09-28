import { Dashboard } from "@/components/Dashboard";
import { Disclaimer } from "@/components/Disclaimer";
import { TickerForm } from "@/components/TickerForm";
import { Notice } from "@/components/ui";
import { ANALYSIS_LIMIT_SUMMARY, checkAnalysisRateLimit } from "@/lib/analysis-rate-limit";
import { formatWait } from "@/lib/format";
import { validateKalshiTicker, validateStockTicker } from "@/lib/validation";

// Cap on how long Vercel lets this page's server function run. The worst case is about
// 18 seconds: Kalshi's three lookups run in sequence, each with a 6-second timeout.
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
    <div className="mx-auto w-full max-w-6xl flex-1 px-4 py-8 sm:px-6 lg:py-10">
      <header className="mb-6">
        <h1 className="text-2xl font-semibold tracking-tight">EventLens</h1>
        <p className="mt-1 text-sm text-ink-secondary">
          Compare Kalshi prediction-market probabilities with stock-market data.
        </p>
      </header>

      <div className="mb-6 rounded-xl border border-border bg-surface p-5">
        <TickerForm
          initialStock={stock.ok ? stock.value : (rawStock ?? "")}
          initialKalshi={kalshi.ok ? kalshi.value : (rawKalshi ?? "")}
        />
      </div>

      {!hasQuery ? (
        <div className="rounded-xl border border-dashed border-border p-10 text-center text-sm text-ink-secondary">
          Enter a stock ticker and a Kalshi market ticker, then click <span className="text-ink">Analyze</span>.
          <br />
          Market tickers appear in Kalshi market URLs and look like{" "}
          <span className="font-mono text-ink">KXFEDDECISION-26OCT-H25</span>.
        </div>
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
