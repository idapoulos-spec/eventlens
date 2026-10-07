import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { COLLECTOR_ROLE } from "./migrate";
import { createTestDb, type TestDb } from "./test-db";
import { readWatchlist, removeWatchItem, saveWatchItem, setWatchActive, validateWatchItem } from "./watchlist";

describe("validateWatchItem", () => {
  it("normalizes the key and defaults to every interval the kind allows", () => {
    expect(validateWatchItem({ kind: "stock", key: " brk.b " })).toEqual({
      ok: true,
      kind: "stock",
      key: "BRK.B",
      intervals: ["30min", "1day"],
    });
    expect(validateWatchItem({ kind: "kalshi_series", key: "kxfeddecision", intervals: ["1440", "1440"] })).toEqual({
      ok: true,
      kind: "kalshi_series",
      key: "KXFEDDECISION",
      intervals: ["1440"],
    });
  });

  it("rejects unknown kinds, bad keys, and intervals from the other source", () => {
    expect(validateWatchItem({ kind: "crypto", key: "BTC" })).toMatchObject({ ok: false });
    expect(validateWatchItem({ kind: "stock", key: "NOT A TICKER" })).toMatchObject({ ok: false });
    expect(validateWatchItem({ kind: "stock", key: "SPY", intervals: ["60"] })).toEqual({
      ok: false,
      message: "stock intervals must be from 30min, 1day, not 60.",
    });
  });
});

describe("the watchlist", () => {
  let db: TestDb;
  beforeEach(async () => {
    db = await createTestDb();
  });
  afterEach(() => db.close());

  it("starts with KXFEDDECISION active and the stocks on hold", async () => {
    const active = await readWatchlist(db.sql);
    expect(active.map((i) => [i.kind, i.key, i.intervals])).toEqual([["kalshi_series", "KXFEDDECISION", ["60", "1440"]]]);

    const stocks = await readWatchlist(db.sql, { kind: "stock", includeInactive: true });
    expect(stocks.map((i) => i.key)).toEqual(["JPM", "KRE", "NVDA", "QQQ", "SPY", "TLT", "XLF"]);
    expect(stocks.every((i) => !i.active && i.intervals.join() === "30min,1day")).toBe(true);
    expect(stocks[0].note).toMatch(/On hold until Twelve Data confirms/);
  });

  it("adds, updates, turns on and off, and removes items", async () => {
    const added = await saveWatchItem(db.sql, { kind: "kalshi_market", key: "KXTEST-26OCT-H0", intervals: ["60"] });
    expect(added).toMatchObject({ kind: "kalshi_market", key: "KXTEST-26OCT-H0", intervals: ["60"], active: true, note: null });
    expect(added.addedAt).toBeGreaterThan(0);

    const updated = await saveWatchItem(db.sql, { kind: "kalshi_market", key: "KXTEST-26OCT-H0", intervals: ["60", "1440"], note: "Test" });
    expect(updated).toMatchObject({ id: added.id, intervals: ["60", "1440"], note: "Test" });

    expect(await setWatchActive(db.sql, "stock", "SPY", true)).toBe(true);
    expect((await readWatchlist(db.sql, { kind: "stock" })).map((i) => i.key)).toEqual(["SPY"]);
    expect(await setWatchActive(db.sql, "stock", "IBM", true)).toBe(false);

    expect(await removeWatchItem(db.sql, "kalshi_market", "KXTEST-26OCT-H0")).toBe(true);
    expect(await removeWatchItem(db.sql, "kalshi_market", "KXTEST-26OCT-H0")).toBe(false);
  });

  it("can be read by the collector but not changed", async () => {
    await db.asRole(COLLECTOR_ROLE, async (sql) => {
      expect(await readWatchlist(sql)).toHaveLength(1);
      await expect(setWatchActive(sql, "stock", "SPY", true)).rejects.toThrow(/permission denied/);
    });
  });
});
