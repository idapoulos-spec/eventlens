// Analyses viewed recently, kept in this browser's localStorage. They never reach the server.

import { validateKalshiTicker, validateStockTicker } from "@/lib/validation";
import { sameAnalysis, type Analysis } from "./navigation";

export interface RecentAnalysis extends Analysis {
  /** The Kalshi market's title the last time it loaded; null if it didn't. */
  title: string | null;
  /** When the analysis was last viewed (ms). */
  viewedAt: number;
}

export const RECENT_STORAGE_KEY = "eventlens:recent-analyses";
export const MAX_RECENT = 6;
const MAX_TITLE_LENGTH = 200;

/** The list before anything is stored; also what the server renders. */
export const NO_RECENT: RecentAnalysis[] = [];

function cleanTitle(title: unknown): string | null {
  if (typeof title !== "string" || !title.trim()) return null;
  // Count characters, not UTF-16 units, so emoji are never split.
  const chars = Array.from(title.trim());
  return chars.length > MAX_TITLE_LENGTH ? `${chars.slice(0, MAX_TITLE_LENGTH).join("")}…` : chars.join("");
}

/** Stored data can be stale or edited by hand, so every entry is checked like URL input. */
function parseEntry(value: unknown): RecentAnalysis | null {
  if (typeof value !== "object" || value === null) return null;
  const { stock, kalshi, title, viewedAt } = value as Record<string, unknown>;
  if (typeof stock !== "string" || typeof kalshi !== "string") return null;
  if (typeof viewedAt !== "number" || !Number.isFinite(viewedAt)) return null;
  const s = validateStockTicker(stock);
  const k = validateKalshiTicker(kalshi);
  if (!s.ok || !k.ok) return null;
  return { stock: s.value, kalshi: k.value, title: cleanTitle(title), viewedAt };
}

/** The stored list, newest first; anything unreadable is dropped. */
export function parseRecent(raw: string | null): RecentAnalysis[] {
  if (!raw) return [];
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(data)) return [];
  const list: RecentAnalysis[] = [];
  for (const item of data) {
    const entry = parseEntry(item);
    if (entry && !list.some((e) => sameAnalysis(e, entry))) list.push(entry);
    if (list.length === MAX_RECENT) break;
  }
  return list;
}

/** Moves the analysis to the front. A null title keeps the one from an earlier view. */
export function addRecent(list: RecentAnalysis[], analysis: Analysis, title: string | null, now: number): RecentAnalysis[] {
  const previous = list.find((e) => sameAnalysis(e, analysis));
  const entry: RecentAnalysis = {
    stock: analysis.stock,
    kalshi: analysis.kalshi,
    title: cleanTitle(title) ?? previous?.title ?? null,
    viewedAt: now,
  };
  return [entry, ...list.filter((e) => e !== previous)].slice(0, MAX_RECENT);
}

export function removeRecent(list: RecentAnalysis[], analysis: Analysis): RecentAnalysis[] {
  return list.filter((e) => !sameAnalysis(e, analysis));
}

/** An external store for useSyncExternalStore. */
export interface RecentStore {
  subscribe(listener: () => void): () => void;
  /** Returns the same array until the stored list changes. */
  getSnapshot(): RecentAnalysis[];
  record(analysis: Analysis, title: string | null): void;
  remove(analysis: Analysis): void;
}

/**
 * When storage is unavailable (getStorage returns null or throws, e.g. with site data
 * blocked) or full, the list simply stays as it is.
 */
export function createRecentStore(getStorage: () => Storage | null, now: () => number = Date.now): RecentStore {
  const listeners = new Set<() => void>();
  let cachedRaw: string | null = null;
  let cached = NO_RECENT;

  function read(): string | null {
    try {
      return getStorage()?.getItem(RECENT_STORAGE_KEY) ?? null;
    } catch {
      return null;
    }
  }

  function getSnapshot(): RecentAnalysis[] {
    const raw = read();
    if (raw !== cachedRaw) {
      cachedRaw = raw;
      cached = parseRecent(raw);
    }
    return cached;
  }

  function write(list: RecentAnalysis[]) {
    try {
      getStorage()?.setItem(RECENT_STORAGE_KEY, JSON.stringify(list));
    } catch {
      return;
    }
    for (const listener of listeners) listener();
  }

  function subscribe(listener: () => void) {
    listeners.add(listener);
    // Changes made in other tabs arrive as storage events.
    const onStorage = (e: StorageEvent) => {
      if (e.key === RECENT_STORAGE_KEY || e.key === null) listener();
    };
    if (typeof window !== "undefined") window.addEventListener("storage", onStorage);
    return () => {
      listeners.delete(listener);
      if (typeof window !== "undefined") window.removeEventListener("storage", onStorage);
    };
  }

  return {
    subscribe,
    getSnapshot,
    record: (analysis, title) => write(addRecent(getSnapshot(), analysis, title, now())),
    remove: (analysis) => write(removeRecent(getSnapshot(), analysis)),
  };
}

/** This browser's recent analyses. */
export const recentAnalyses = createRecentStore(() => (typeof window === "undefined" ? null : window.localStorage));
