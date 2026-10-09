import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTestDb, type TestDb } from "@/lib/store/test-db";
import { readStoredKalshiWindow, readStoredMarket } from "./kalshi";
import { HOUR_MS, seedCandles, seedCoverage, seedMarket, seedRun } from "./test-fixtures";

const TICKER = "KXFEDDECISION-25DEC-H0";
const OPEN = Date.UTC(2025, 9, 30, 14);
const CLOSE = Date.UTC(2025, 11, 10, 19);

let db: TestDb;

beforeEach(async () => {
  db = await createTestDb();
});
afterEach(() => db.close());

describe("stored Kalshi reads (as the app's role)", () => {
  it("reads a stored market, or nothing for one that isn't", async () => {
    await seedMarket(db.sql, { ticker: TICKER, status: "finalized", openTime: OPEN, closeTime: CLOSE, raw: { result: "yes" } });

    const market = await db.asRole("eventlens_app", (sql) => readStoredMarket(sql, TICKER));
    expect(market).toMatchObject({ openTime: OPEN, closeTime: CLOSE, raw: { ticker: TICKER, status: "finalized", result: "yes" } });
    expect(await db.asRole("eventlens_app", (sql) => readStoredMarket(sql, "KXFEDDECISION-25DEC-H25"))).toBeNull();
  });

  it("reads a window's hourly candles as numbers, and what its coverage misses", async () => {
    const run = await seedRun(db.sql);
    const id = await seedMarket(db.sql, { ticker: TICKER, status: "finalized", openTime: OPEN, closeTime: CLOSE });
    const t = (h: number) => OPEN + h * HOUR_MS;
    await seedCandles(db.sql, run, id, [
      { t: t(1), bid: 0.45, ask: 0.47, close: 0.46 },
      { t: t(2), ask: 0.5, previous: 0.46 },
      // Outside the window read below.
      { t: t(10), bid: 0.6, ask: 0.62 },
    ]);
    await seedCoverage(db.sql, run, "kalshi", TICKER, "60", t(0), t(5));

    const window = await db.asRole("eventlens_app", (sql) => readStoredKalshiWindow(sql, TICKER, { from: t(1), to: t(8) }));
    expect(window.candles).toEqual([
      { endTs: t(1), yesBid: { close: 450000 }, yesAsk: { close: 470000 }, price: { close: 460000, previous: null } },
      { endTs: t(2), yesBid: { close: null }, yesAsk: { close: 500000 }, price: { close: null, previous: 460000 } },
    ]);
    expect(window.gaps).toEqual([{ from: t(5), to: t(8) }]);
    expect(window.market?.closeTime).toBe(CLOSE);
  });

  it("finds no market, no candles, and the whole window missing when nothing is stored", async () => {
    const window = await db.asRole("eventlens_app", (sql) => readStoredKalshiWindow(sql, TICKER, { from: OPEN, to: CLOSE }));
    expect(window).toEqual({ market: null, candles: [], gaps: [{ from: OPEN, to: CLOSE }] });
  });
});
