"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition, type FormEvent } from "react";
import { validateKalshiTicker, validateStockTicker } from "@/lib/validation";
import { KalshiSearch } from "./search/KalshiSearch";
import { StockSearch } from "./search/StockSearch";

export const EXAMPLES = [
  { stock: "NVDA", kalshi: "KXNASDAQ100Y-26DEC31H1600-T33000", label: "Nasdaq-100 above 33,000 at year-end" },
  { stock: "JPM", kalshi: "KXFEDDECISION-26OCT-H25", label: "Fed hikes 25bps in October" },
  { stock: "SPY", kalshi: "KXRECSSNBER-27", label: "US recession in 2027" },
];

type Field = "stock" | "kalshi";

export function TickerForm({ initialStock = "", initialKalshi = "" }: { initialStock?: string; initialKalshi?: string }) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [stock, setStock] = useState(initialStock);
  const [kalshi, setKalshi] = useState(initialKalshi);
  const [error, setError] = useState<{ field: Field; message: string } | null>(null);

  function analyze(stockInput: string, kalshiInput: string) {
    const s = validateStockTicker(stockInput);
    const k = validateKalshiTicker(kalshiInput);
    if (!s.ok) return setError({ field: "stock", message: s.message });
    if (!k.ok) return setError({ field: "kalshi", message: k.message });
    setError(null);
    setStock(s.value);
    setKalshi(k.value);
    const params = new URLSearchParams({ stock: s.value, kalshi: k.value });
    startTransition(() => router.push(`/?${params}`));
  }

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    analyze(stock, kalshi);
  }

  return (
    <div>
      <form onSubmit={onSubmit} className="grid gap-3 sm:grid-cols-[minmax(0,10rem)_minmax(0,1fr)_auto] sm:items-end">
        {/* Both fields accept a typed ticker as well as a picked search result. */}
        <StockSearch value={stock} onSelect={(ticker) => setStock(ticker)} invalid={error?.field === "stock"} />
        <KalshiSearch value={kalshi} onSelect={(ticker) => setKalshi(ticker)} invalid={error?.field === "kalshi"} />
        <button
          type="submit"
          disabled={isPending}
          className="inline-flex h-11 items-center justify-center gap-2 rounded-lg bg-series-kalshi px-5 text-sm font-semibold text-white transition hover:brightness-110 disabled:cursor-wait disabled:opacity-70 sm:h-10"
        >
          {isPending && (
            <span
              aria-hidden
              className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-white/35 border-t-white motion-reduce:animate-none"
            />
          )}
          {isPending ? "Analyzing…" : "Analyze"}
        </button>
      </form>
      {error && (
        <p role="alert" className="mt-2 text-sm text-down">
          {error.message}
        </p>
      )}
      <div className="mt-4 flex flex-wrap items-center gap-2 text-xs">
        <span className="text-ink-muted">Examples</span>
        {EXAMPLES.map((ex) => (
          <button
            key={ex.kalshi}
            type="button"
            disabled={isPending}
            onClick={() => analyze(ex.stock, ex.kalshi)}
            title={`${ex.stock} vs. ${ex.kalshi}`}
            className="inline-flex max-w-full items-center gap-1.5 rounded-md border border-border px-2.5 py-1.5 text-ink-secondary transition hover:bg-surface-raised hover:text-ink disabled:cursor-wait disabled:opacity-50"
          >
            <span className="font-mono text-ink">{ex.stock}</span>
            <span className="truncate">{ex.label}</span>
          </button>
        ))}
      </div>
    </div>
  );
}
