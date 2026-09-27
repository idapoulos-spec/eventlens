"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition, type FormEvent } from "react";
import { validateKalshiTicker, validateStockTicker } from "@/lib/validation";

export const EXAMPLES = [
  { stock: "NVDA", kalshi: "KXNASDAQ100Y-26DEC31H1600-T33000", label: "Nasdaq-100 above 33,000 at year-end" },
  { stock: "JPM", kalshi: "KXFEDDECISION-26OCT-H25", label: "Fed hikes 25bps in October" },
  { stock: "SPY", kalshi: "KXRECSSNBER-27", label: "US recession in 2027" },
];

export function TickerForm({ initialStock = "", initialKalshi = "" }: { initialStock?: string; initialKalshi?: string }) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [stock, setStock] = useState(initialStock);
  const [kalshi, setKalshi] = useState(initialKalshi);
  const [error, setError] = useState<string | null>(null);

  function analyze(stockInput: string, kalshiInput: string) {
    const s = validateStockTicker(stockInput);
    const k = validateKalshiTicker(kalshiInput);
    if (!s.ok || !k.ok) {
      setError(!s.ok ? s.message : !k.ok ? k.message : null);
      return;
    }
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

  const inputClass =
    "w-full rounded-lg border border-border bg-surface-raised px-3 py-2.5 font-mono text-sm uppercase text-ink placeholder:normal-case placeholder:text-ink-muted focus:border-series-kalshi focus:outline-none focus:ring-1 focus:ring-series-kalshi";

  return (
    <div>
      <form onSubmit={onSubmit} className="grid gap-3 sm:grid-cols-[minmax(0,10rem)_minmax(0,1fr)_auto] sm:items-end">
        <label className="block">
          <span className="mb-1.5 block text-xs font-medium text-ink-secondary">Stock ticker</span>
          <input
            name="stock"
            value={stock}
            onChange={(e) => setStock(e.target.value)}
            placeholder="e.g. NVDA"
            autoComplete="off"
            spellCheck={false}
            maxLength={12}
            className={inputClass}
          />
        </label>
        <label className="block">
          <span className="mb-1.5 block text-xs font-medium text-ink-secondary">Kalshi market ticker</span>
          <input
            name="kalshi"
            value={kalshi}
            onChange={(e) => setKalshi(e.target.value)}
            placeholder="e.g. KXFEDDECISION-26OCT-H25"
            autoComplete="off"
            spellCheck={false}
            maxLength={100}
            className={inputClass}
          />
        </label>
        <button
          type="submit"
          disabled={isPending}
          className="rounded-lg bg-series-kalshi px-5 py-2.5 text-sm font-semibold text-white transition hover:brightness-110 disabled:cursor-wait disabled:opacity-60"
        >
          {isPending ? "Analyzing…" : "Analyze"}
        </button>
      </form>
      {error && (
        <p role="alert" className="mt-2 text-sm text-down">
          {error}
        </p>
      )}
      <div className="mt-3 flex flex-wrap items-center gap-2 text-xs text-ink-muted">
        <span>Try:</span>
        {EXAMPLES.map((ex) => (
          <button
            key={ex.kalshi}
            type="button"
            onClick={() => analyze(ex.stock, ex.kalshi)}
            title={ex.label}
            className="rounded-md border border-border px-2 py-1 font-mono text-ink-secondary transition hover:bg-surface-raised hover:text-ink"
          >
            {ex.stock} · {ex.kalshi}
          </button>
        ))}
      </div>
    </div>
  );
}
