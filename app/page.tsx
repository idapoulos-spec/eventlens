import type { Metadata } from "next";
import { AnalysisFlow, AnalysisResults } from "@/components/analysis/AnalysisFlow";
import { CopyLinkButton } from "@/components/analysis/CopyLinkButton";
import { analysisHref, type Analysis } from "@/components/analysis/navigation";
import { SignOutButton } from "@/components/auth/SignOutButton";
import { Dashboard } from "@/components/Dashboard";
import { Disclaimer } from "@/components/Disclaimer";
import { LogoMark } from "@/components/LogoMark";
import { TickerForm, type PageView } from "@/components/TickerForm";
import { Notice } from "@/components/ui";
import { ANALYSIS_LIMIT_SUMMARY, checkAnalysisRateLimit } from "@/lib/analysis-rate-limit";
import { isAccessGateOn, requirePageSession } from "@/lib/auth/server";
import { formatWait } from "@/lib/format";
import { validateKalshiTicker, validateStockTicker } from "@/lib/validation";

// Cap on how long Vercel lets this page's server function run. Worst cases, with every request
// taking its whole timeout (6 s upstream, 2.5 s for a data store read):
// - Without the store, about 12 s: every request starts at once, except Research's benchmark,
//   which waits for the stock's requests.
// - With it, about 32 s, for a market settled before Kalshi's archive cutoff: the market lookup
//   (the live 404, the stored row, then the archive: 14.5 s) sets Research's window; the stock's
//   history waits for it (stored bars, then requests: 8.5 s), and the benchmark for the stock
//   (the same again: 8.5 s).
export const maxDuration = 40;

const first = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);

/** The analysis the URL asks for: each ticker as given, and validated. */
function readQuery(params: Awaited<PageProps<"/">["searchParams"]>) {
  const rawStock = first(params.stock);
  const rawKalshi = first(params.kalshi);
  return {
    rawStock,
    rawKalshi,
    hasQuery: rawStock !== undefined || rawKalshi !== undefined,
    stock: validateStockTicker(rawStock),
    kalshi: validateKalshiTicker(rawKalshi),
  };
}

// A shared link's tab title and preview name the analysis. Only the URL is read: no market data is fetched.
export async function generateMetadata({ searchParams }: PageProps<"/">): Promise<Metadata> {
  const { stock, kalshi } = readQuery(await searchParams);
  if (!stock.ok || !kalshi.ok) return {};
  return {
    title: `${stock.value} vs. ${kalshi.value} · EventLens`,
    description: `Kalshi market ${kalshi.value} compared with ${stock.value} stock on EventLens.`,
  };
}

export default async function Home({ searchParams }: PageProps<"/">) {
  await requirePageSession();
  const { rawStock, rawKalshi, hasQuery, stock, kalshi } = readQuery(await searchParams);
  // Only valid analyses reach the upstream APIs, so only they count against the limit.
  const rateLimit = stock.ok && kalshi.ok ? await checkAnalysisRateLimit() : { ok: true as const };
  const analysis = stock.ok && kalshi.ok && rateLimit.ok ? { stock: stock.value, kalshi: kalshi.value } : null;
  const view: PageView = !hasQuery ? "start" : analysis ? "analysis" : "notice";

  return (
    <AnalysisFlow>
      <div className="mx-auto w-full max-w-6xl flex-1 px-4 py-6 sm:px-6 sm:py-8 lg:py-10">
        <header className="mb-5 flex items-start justify-between gap-4 sm:mb-6">
          <div className="min-w-0">
            <h1 className="flex items-center gap-2.5 text-2xl font-semibold tracking-tight">
              <LogoMark />
              EventLens
            </h1>
            <p className="mt-1 text-sm text-ink-secondary">
              Compare Kalshi prediction-market probabilities with stock-market data.
            </p>
          </div>
          {isAccessGateOn() && <SignOutButton />}
        </header>

        <div className="mb-5 rounded-xl border border-border bg-surface p-4 sm:mb-6 sm:p-5">
          <TickerForm
            initialStock={stock.ok ? stock.value : (rawStock ?? "")}
            initialKalshi={kalshi.ok ? kalshi.value : (rawKalshi ?? "")}
            view={view}
          />
        </div>

        <AnalysisResults label={analysis ? `Analysis of ${analysis.stock} vs. ${analysis.kalshi}` : undefined}>
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
            // The key remounts the analysis for each new one, so it fades in and every section shows its loading state again.
            <div
              key={`${stock.value}|${kalshi.value}`}
              className="transition duration-300 ease-out starting:opacity-0 motion-safe:starting:translate-y-2"
            >
              <ResultsBar stock={stock.value} kalshi={kalshi.value} />
              <Dashboard stock={stock.value} kalshi={kalshi.value} />
            </div>
          )}
        </AnalysisResults>

        <footer className="mt-10 border-t border-border pt-4">
          <Disclaimer />
        </footer>
      </div>
    </AnalysisFlow>
  );
}

/** Names the analysis on screen (where phones scroll to after Analyze) and offers its link to share. */
function ResultsBar({ stock, kalshi }: Analysis) {
  return (
    <div className="mb-3 flex items-center justify-between gap-3">
      <p className="min-w-0 truncate text-xs text-ink-muted">
        <span className="font-mono text-ink-secondary">{stock}</span> vs.{" "}
        <span className="font-mono text-ink-secondary">{kalshi}</span>
      </p>
      <CopyLinkButton href={analysisHref({ stock, kalshi })} />
    </div>
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
