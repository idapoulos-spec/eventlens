"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { validateKalshiTicker, validateStockTicker, type Validated } from "@/lib/validation";
import { useAnalysisFlow } from "./analysis/AnalysisFlow";
import { AnalysisLink } from "./analysis/AnalysisLink";
import { analysisHref, submitAction, type Analysis } from "./analysis/navigation";
import { RecentAnalyses } from "./analysis/RecentAnalyses";
import { KalshiSearch } from "./search/KalshiSearch";
import { isKalshiSearchText } from "./search/KalshiSearchModel";
import { StockSearch } from "./search/StockSearch";
import { unlistedTickerMatch } from "./search/StockSearchFetch";

export const EXAMPLES = [
  { stock: "NVDA", kalshi: "KXNASDAQ100Y-26DEC31H1600-T33000", label: "Nasdaq-100 above 33,000 at year-end" },
  { stock: "JPM", kalshi: "KXFEDDECISION-26OCT-H25", label: "Fed hikes 25bps in October" },
  { stock: "SPY", kalshi: "KXRECSSNBER-27", label: "US recession in 2027" },
];

type Field = "stock" | "kalshi";

/** What the page shows below the form: the start screen, an analysis, or a notice (invalid input, or rate limited). */
export type PageView = "start" | "analysis" | "notice";

/** The analysis in the URL, if both tickers are valid. The page passes valid tickers normalized. */
function urlAnalysis(stock: string, kalshi: string): Analysis | null {
  return validateStockTicker(stock).ok && validateKalshiTicker(kalshi).ok ? { stock, kalshi } : null;
}

// Both fields also take search text. Text that isn't a ticker is pointed to the search results,
// and so is text that looks like one but that the field's search found to be a name or keyword
// (e.g. "nvidia"): analyzing it would spend Twelve Data credits on an error.

/** The stock field's ticker, or why it can't be analyzed. */
function checkStock(text: string): Validated {
  const ticker = validateStockTicker(text);
  if (!ticker.ok) return text.trim() ? { ok: false, message: "Pick a stock from the list, or enter a ticker such as NVDA." } : ticker;
  const match = unlistedTickerMatch(text);
  if (!match) return ticker;
  return {
    ok: false,
    message: `No US stock or ETF has the ticker ${ticker.value}. Pick one from the list, such as ${match.symbol} (${match.name}).`,
  };
}

/** The Kalshi field's ticker, or why it can't be analyzed. */
function checkKalshi(text: string): Validated {
  const ticker = validateKalshiTicker(text);
  if (!text.trim() || (ticker.ok && !isKalshiSearchText(text))) return ticker;
  return { ok: false, message: "Pick a market from the list, or paste a Kalshi market ticker." };
}

/** On touch screens, close the on-screen keyboard so the results have the screen. */
function closeKeyboard() {
  const active = document.activeElement;
  if (active instanceof HTMLInputElement && window.matchMedia("(pointer: coarse)").matches) active.blur();
}

export function TickerForm({
  initialStock = "",
  initialKalshi = "",
  view = "start",
}: {
  initialStock?: string;
  initialKalshi?: string;
  view?: PageView;
}) {
  const router = useRouter();
  const { pending, load, reload, reveal } = useAnalysisFlow();
  const formRef = useRef<HTMLFormElement>(null);
  const [stock, setStock] = useState(initialStock);
  const [kalshi, setKalshi] = useState(initialKalshi);
  const [error, setError] = useState<{ field: Field; message: string } | null>(null);

  // The fields follow the URL whenever it changes (back and forward, Clear, a picked
  // analysis), so they always show the analysis on screen.
  const [urlFields, setUrlFields] = useState({ stock: initialStock, kalshi: initialKalshi });
  if (urlFields.stock !== initialStock || urlFields.kalshi !== initialKalshi) {
    setUrlFields({ stock: initialStock, kalshi: initialKalshi });
    setStock(initialStock);
    setKalshi(initialKalshi);
    setError(null);
  }

  const current = urlAnalysis(initialStock, initialKalshi);
  // When the results for `current` appeared; null while none are showing.
  const shownAt = useRef<number | null>(null);
  useEffect(() => {
    shownAt.current = view === "analysis" ? Date.now() : null;
  }, [view, initialStock, initialKalshi]);

  function analyze(stockInput: string, kalshiInput: string) {
    const s = checkStock(stockInput);
    const k = checkKalshi(kalshiInput);
    if (!s.ok) return setError({ field: "stock", message: s.message });
    if (!k.ok) return setError({ field: "kalshi", message: k.message });
    setError(null);
    setStock(s.value);
    setKalshi(k.value);
    closeKeyboard();

    const next = { stock: s.value, kalshi: k.value };
    const action = submitAction(next, current, shownAt.current, Date.now());
    if (action === "reveal") return reveal();
    if (action === "refresh") {
      if (view === "analysis") shownAt.current = Date.now();
      return reload();
    }
    load(analysisHref(next));
  }

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    analyze(stock, kalshi);
  }

  const pick = (a: Analysis) => analyze(a.stock, a.kalshi);

  // Clear starts over: both fields empty, and back to the start screen (Back returns to the analysis).
  const canClear = stock !== "" || kalshi !== "" || view !== "start";
  function clear() {
    setStock("");
    setKalshi("");
    setError(null);
    const field = formRef.current?.elements.namedItem("stock");
    if (field instanceof HTMLElement) field.focus();
    if (view !== "start") router.push("/", { scroll: false });
  }

  return (
    <div>
      <form
        ref={formRef}
        onSubmit={onSubmit}
        className="grid gap-3 sm:grid-cols-[minmax(0,10rem)_minmax(0,1fr)_auto] sm:items-end"
      >
        {/* Both fields accept a typed ticker as well as a picked search result. */}
        <StockSearch value={stock} onSelect={(ticker) => setStock(ticker)} invalid={error?.field === "stock"} />
        <KalshiSearch value={kalshi} onSelect={(ticker) => setKalshi(ticker)} invalid={error?.field === "kalshi"} />
        <div className="flex gap-2">
          <button
            type="submit"
            disabled={pending}
            className="inline-flex h-11 flex-1 items-center justify-center gap-2 rounded-lg bg-series-kalshi px-5 text-sm font-semibold text-white transition hover:brightness-110 disabled:cursor-wait disabled:opacity-70 sm:h-10 sm:flex-none"
          >
            {pending && (
              <span
                aria-hidden
                className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-white/35 border-t-white motion-reduce:animate-none"
              />
            )}
            {pending ? "Analyzing…" : "Analyze"}
          </button>
          <button
            type="button"
            onClick={clear}
            disabled={pending || !canClear}
            className="inline-flex h-11 items-center justify-center rounded-lg border border-border px-4 text-sm font-medium text-ink-secondary transition hover:bg-surface-raised hover:text-ink disabled:pointer-events-none disabled:opacity-40 sm:h-10"
          >
            Clear
          </button>
        </div>
      </form>
      {error && (
        <p role="alert" className="mt-2 text-sm text-down">
          {error.message}
        </p>
      )}
      <RecentAnalyses exclude={view === "analysis" ? current : null} disabled={pending} onPick={pick} />
      {/* Examples are for getting started, so they give way to results. */}
      {view !== "analysis" && (
        <div className="mt-4 flex flex-wrap items-center gap-2 text-xs">
          <span className="text-ink-muted">Examples</span>
          {EXAMPLES.map((ex) => (
            <AnalysisLink
              key={ex.kalshi}
              analysis={ex}
              onPick={pick}
              disabled={pending}
              title={`${ex.stock} vs. ${ex.kalshi}`}
              className="inline-flex max-w-full items-center gap-1.5 rounded-md border border-border px-2.5 py-1.5 text-ink-secondary transition hover:bg-surface-raised hover:text-ink aria-disabled:cursor-wait aria-disabled:opacity-50"
            >
              <span className="font-mono text-ink">{ex.stock}</span>
              <span className="truncate">{ex.label}</span>
            </AnalysisLink>
          ))}
        </div>
      )}
    </div>
  );
}
