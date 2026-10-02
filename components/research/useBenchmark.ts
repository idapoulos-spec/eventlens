"use client";

// The Research panel's benchmark: SPY from the server to start with, others loaded from
// /api/benchmark when picked. Loaded benchmarks stay in memory for the analysis, so switching
// back to one costs no request.

import { useRef, useState } from "react";
import {
  BENCHMARK_API_PATH,
  BENCHMARK_SYMBOL_PARAM,
  DEFAULT_BENCHMARK,
  type BenchmarkErrorResponse,
} from "@/lib/market-data/benchmark-series";
import type { BenchmarkSeries } from "@/lib/market-data/types";
import { fail, ok, type Result } from "@/lib/result";

export interface BenchmarkChoice {
  symbol: string;
  /** Full name, when known (e.g. from a picked search result). */
  name: string | null;
}

export type BenchmarkStatus =
  | { state: "ready" }
  | { state: "loading"; choice: BenchmarkChoice }
  | { state: "error"; choice: BenchmarkChoice; message: string };

const OFFLINE = "Couldn't reach the server. Check your connection and try again.";
const UNAVAILABLE = "Benchmark prices couldn't be loaded. Please try again shortly.";

/** Loads one benchmark. Resolves to null if `signal` aborts (another benchmark was picked); never rejects. */
export async function fetchBenchmark(symbol: string, signal?: AbortSignal): Promise<Result<BenchmarkSeries> | null> {
  try {
    const res = await fetch(`${BENCHMARK_API_PATH}?${new URLSearchParams({ [BENCHMARK_SYMBOL_PARAM]: symbol })}`, { signal });
    const body = (await res.json().catch(() => null)) as Partial<BenchmarkSeries & BenchmarkErrorResponse> | null;
    if (signal?.aborted) return null;
    if (res.ok && Array.isArray(body?.hourly) && Array.isArray(body?.daily)) return ok(body as BenchmarkSeries);
    return fail(body?.error?.code ?? "unavailable", body?.error?.message ?? UNAVAILABLE);
  } catch {
    return signal?.aborted ? null : fail("offline", OFFLINE);
  }
}

export interface Benchmark {
  /** The benchmark in use. */
  active: BenchmarkChoice;
  /** Its prices, or null if it has none (it failed to load, or is the stock itself). */
  series: BenchmarkSeries | null;
  status: BenchmarkStatus;
  /** Switch to a benchmark, loading it first unless it's loaded or `skipLoad` (e.g. it's the stock itself). */
  choose: (choice: BenchmarkChoice, options?: { skipLoad?: boolean }) => void;
}

/** @param initial the default benchmark as the server loaded it, or null if it didn't. */
export function useBenchmark(initial: Result<BenchmarkSeries> | null): Benchmark {
  const [active, setActive] = useState<BenchmarkChoice>(DEFAULT_BENCHMARK);
  const [loaded, setLoaded] = useState<Record<string, BenchmarkSeries>>(() =>
    initial?.ok ? { [initial.data.symbol]: initial.data } : {},
  );
  const [status, setStatus] = useState<BenchmarkStatus>(() =>
    initial && !initial.ok ? { state: "error", choice: DEFAULT_BENCHMARK, message: initial.error.message } : { state: "ready" },
  );
  // The request in flight, if any. A ref, so a second pick of the same symbol in the same
  // event (a picked result, then Enter) doesn't start another request.
  const pending = useRef<{ symbol: string; controller: AbortController } | null>(null);

  async function choose(choice: BenchmarkChoice, { skipLoad = false } = {}) {
    if (pending.current?.symbol === choice.symbol) return;
    pending.current?.controller.abort();
    pending.current = null;
    if (skipLoad || loaded[choice.symbol]) {
      setActive(choice);
      setStatus({ state: "ready" });
      return;
    }
    const controller = new AbortController();
    pending.current = { symbol: choice.symbol, controller };
    setStatus({ state: "loading", choice });
    const result = await fetchBenchmark(choice.symbol, controller.signal);
    if (!result) return;
    pending.current = null;
    if (result.ok) {
      setLoaded((l) => ({ ...l, [choice.symbol]: result.data }));
      setActive(choice);
      setStatus({ state: "ready" });
    } else {
      setStatus({ state: "error", choice, message: result.error.message });
    }
  }

  return { active, series: loaded[active.symbol] ?? null, status, choose };
}
