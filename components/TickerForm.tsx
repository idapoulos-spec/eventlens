"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition, type FormEvent } from "react";
import { validateKalshiTicker, validateStockTicker } from "@/lib/validation";

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

  // 16px text on phones keeps iOS Safari from zooming in when an input is focused.
  const inputClass =
    "w-full rounded-lg border border-border bg-surface-raised px-3 py-2.5 font-mono text-base uppercase text-ink placeholder:normal-case placeholder:text-ink-muted focus:border-series-kalshi focus:outline-none focus:ring-1 focus:ring-series-kalshi aria-invalid:border-down/60 sm:text-sm";
  const inputProps = (field: Field) => ({
    name: field,
    autoComplete: "off",
    autoCapitalize: "characters",
    autoCorrect: "off",
    spellCheck: false,
    enterKeyHint: "go" as const,
    "aria-invalid": error?.field === field || undefined,
    "aria-describedby": error?.field === field ? "ticker-error" : undefined,
    className: inputClass,
  });

  return (
    <div>
      <form onSubmit={onSubmit} className="grid gap-3 sm:grid-cols-[minmax(0,10rem)_minmax(0,1fr)_auto] sm:items-end">
        <label className="block">
          <span className="mb-1.5 block text-xs font-medium text-ink-secondary">Stock ticker</span>
          <input
            {...inputProps("stock")}
            value={stock}
            onChange={(e) => setStock(e.target.value)}
            placeholder="e.g. NVDA"
            maxLength={12}
          />
        </label>
        <label className="block">
          <span className="mb-1.5 block text-xs font-medium text-ink-secondary">Kalshi market ticker</span>
          <input
            {...inputProps("kalshi")}
            value={kalshi}
            onChange={(e) => setKalshi(e.target.value)}
            placeholder="e.g. KXFEDDECISION-26OCT-H25"
            maxLength={100}
          />
        </label>
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
        <p id="ticker-error" role="alert" className="mt-2 text-sm text-down">
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
