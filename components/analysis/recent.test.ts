import { describe, expect, it, vi } from "vitest";
import {
  addRecent,
  createRecentStore,
  MAX_RECENT,
  parseRecent,
  RECENT_STORAGE_KEY,
  removeRecent,
  type RecentAnalysis,
} from "./recent";

const NVDA = { stock: "NVDA", kalshi: "KXFEDDECISION-26OCT-H25" };
const SPY = { stock: "SPY", kalshi: "KXRECSSNBER-27" };

const entry = (stock: string, kalshi: string, viewedAt = 1, title: string | null = null): RecentAnalysis => ({
  stock,
  kalshi,
  title,
  viewedAt,
});

function memoryStorage(): Storage {
  const items = new Map<string, string>();
  return {
    getItem: (key) => items.get(key) ?? null,
    setItem: (key, value) => void items.set(key, String(value)),
    removeItem: (key) => void items.delete(key),
    clear: () => items.clear(),
    key: (i) => [...items.keys()][i] ?? null,
    get length() {
      return items.size;
    },
  };
}

describe("parseRecent", () => {
  it("reads nothing from missing, malformed, or non-list data", () => {
    expect(parseRecent(null)).toEqual([]);
    expect(parseRecent("")).toEqual([]);
    expect(parseRecent("{not json")).toEqual([]);
    expect(parseRecent('{"stock":"NVDA"}')).toEqual([]);
  });

  it("keeps valid entries in order", () => {
    const list = [entry("NVDA", NVDA.kalshi, 2, "Fed hike"), entry("SPY", SPY.kalshi, 1)];
    expect(parseRecent(JSON.stringify(list))).toEqual(list);
  });

  it("drops entries with invalid tickers, a missing time, or the wrong shape", () => {
    const raw = JSON.stringify([
      null,
      "NVDA",
      { stock: "NVDA", kalshi: NVDA.kalshi },
      { stock: "NVDA", kalshi: NVDA.kalshi, viewedAt: "yesterday" },
      { stock: "NOT A TICKER", kalshi: NVDA.kalshi, viewedAt: 1 },
      { stock: "NVDA", kalshi: "javascript:alert(1)", viewedAt: 1 },
      { stock: "SPY", kalshi: SPY.kalshi, viewedAt: 1 },
    ]);
    expect(parseRecent(raw)).toEqual([entry("SPY", SPY.kalshi, 1)]);
  });

  it("normalizes tickers and titles the way the page does", () => {
    const raw = JSON.stringify([{ stock: " nvda ", kalshi: "kxfeddecision-26oct-h25", viewedAt: 1, title: "  Fed hike  " }]);
    expect(parseRecent(raw)).toEqual([entry("NVDA", NVDA.kalshi, 1, "Fed hike")]);
  });

  it("ignores titles that aren't text and shortens very long ones", () => {
    const raw = JSON.stringify([
      { ...NVDA, viewedAt: 1, title: 42 },
      { ...SPY, viewedAt: 1, title: "x".repeat(500) },
    ]);
    const [nvda, spy] = parseRecent(raw);
    expect(nvda.title).toBeNull();
    expect(spy.title).toBe(`${"x".repeat(200)}…`);
  });

  it("keeps the first of duplicate entries and at most MAX_RECENT", () => {
    const list = Array.from({ length: MAX_RECENT + 3 }, (_, i) => entry(`S${i}`, NVDA.kalshi, i));
    const raw = JSON.stringify([entry("S0", NVDA.kalshi, 99), ...list]);
    const parsed = parseRecent(raw);
    expect(parsed).toHaveLength(MAX_RECENT);
    expect(parsed[0].viewedAt).toBe(99);
    expect(parsed.map((e) => e.stock)).toEqual(["S0", "S1", "S2", "S3", "S4", "S5"]);
  });
});

describe("addRecent", () => {
  it("puts a new analysis first", () => {
    const list = addRecent([entry("SPY", SPY.kalshi, 1)], NVDA, "Fed hike", 5);
    expect(list).toEqual([entry("NVDA", NVDA.kalshi, 5, "Fed hike"), entry("SPY", SPY.kalshi, 1)]);
  });

  it("moves an analysis viewed again to the front instead of repeating it", () => {
    const list = addRecent([entry("SPY", SPY.kalshi, 2), entry("NVDA", NVDA.kalshi, 1, "Old title")], NVDA, "New title", 5);
    expect(list).toEqual([entry("NVDA", NVDA.kalshi, 5, "New title"), entry("SPY", SPY.kalshi, 2)]);
  });

  it("keeps an earlier title when the market didn't load this time", () => {
    const list = addRecent([entry("NVDA", NVDA.kalshi, 1, "Fed hike")], NVDA, null, 5);
    expect(list).toEqual([entry("NVDA", NVDA.kalshi, 5, "Fed hike")]);
  });

  it("drops the oldest analysis beyond MAX_RECENT", () => {
    const full = Array.from({ length: MAX_RECENT }, (_, i) => entry(`S${i}`, SPY.kalshi, MAX_RECENT - i));
    const list = addRecent(full, NVDA, null, 100);
    expect(list).toHaveLength(MAX_RECENT);
    expect(list[0].stock).toBe("NVDA");
    expect(list.some((e) => e.stock === `S${MAX_RECENT - 1}`)).toBe(false);
  });
});

describe("removeRecent", () => {
  it("removes only the matching analysis", () => {
    const list = [entry("NVDA", NVDA.kalshi), entry("NVDA", SPY.kalshi), entry("SPY", SPY.kalshi)];
    expect(removeRecent(list, { stock: "NVDA", kalshi: SPY.kalshi })).toEqual([list[0], list[2]]);
  });
});

describe("createRecentStore", () => {
  it("records analyses in storage, newest first, and notifies subscribers", () => {
    const storage = memoryStorage();
    let time = 10;
    const store = createRecentStore(() => storage, () => time++);
    const listener = vi.fn();
    const unsubscribe = store.subscribe(listener);

    store.record(SPY, null);
    store.record(NVDA, "Fed hike");
    expect(listener).toHaveBeenCalledTimes(2);
    expect(store.getSnapshot()).toEqual([entry("NVDA", NVDA.kalshi, 11, "Fed hike"), entry("SPY", SPY.kalshi, 10)]);
    expect(parseRecent(storage.getItem(RECENT_STORAGE_KEY))).toEqual(store.getSnapshot());

    store.remove(SPY);
    expect(store.getSnapshot()).toEqual([entry("NVDA", NVDA.kalshi, 11, "Fed hike")]);

    unsubscribe();
    store.record(SPY, null);
    expect(listener).toHaveBeenCalledTimes(3);
  });

  it("returns the same snapshot until the stored list changes", () => {
    const storage = memoryStorage();
    const store = createRecentStore(() => storage);
    const empty = store.getSnapshot();
    expect(store.getSnapshot()).toBe(empty);

    store.record(NVDA, null);
    const recorded = store.getSnapshot();
    expect(recorded).not.toBe(empty);
    expect(store.getSnapshot()).toBe(recorded);
  });

  it("picks up changes written by another tab", () => {
    const storage = memoryStorage();
    const store = createRecentStore(() => storage);
    expect(store.getSnapshot()).toEqual([]);
    storage.setItem(RECENT_STORAGE_KEY, JSON.stringify([entry("SPY", SPY.kalshi, 3)]));
    expect(store.getSnapshot()).toEqual([entry("SPY", SPY.kalshi, 3)]);
  });

  it("keeps working, with an empty list, when storage is blocked", () => {
    const store = createRecentStore(() => {
      throw new DOMException("The operation is insecure.", "SecurityError");
    });
    expect(store.getSnapshot()).toEqual([]);
    expect(() => store.record(NVDA, null)).not.toThrow();
    expect(store.getSnapshot()).toEqual([]);
  });

  it("leaves the list unchanged when storage is full", () => {
    const storage = memoryStorage();
    const store = createRecentStore(() => storage);
    store.record(SPY, null);
    storage.setItem = () => {
      throw new DOMException("Quota exceeded", "QuotaExceededError");
    };
    const listener = vi.fn();
    store.subscribe(listener);
    expect(() => store.record(NVDA, null)).not.toThrow();
    expect(listener).not.toHaveBeenCalled();
    expect(store.getSnapshot().map((e) => e.stock)).toEqual(["SPY"]);
  });
});
