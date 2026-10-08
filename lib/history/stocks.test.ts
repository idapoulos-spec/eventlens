import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTestDb, type TestDb } from "@/lib/store/test-db";
import { readStoredStockWindow } from "./stocks";
import { DAY_MS, HOUR_MS, seedBars, seedCoverage, seedRun } from "./test-fixtures";

const HALF_HOUR_MS = HOUR_MS / 2;
// Tuesday, Dec 9, 2025: New York is UTC−5, so the session runs 14:30–21:00 UTC.
const DATE = Date.UTC(2025, 11, 9);
const OPEN = DATE + 14.5 * HOUR_MS;

let db: TestDb;
let run: number;

beforeEach(async () => {
  db = await createTestDb();
  run = await seedRun(db.sql, "stocks");
});
afterEach(() => db.close());

const read = (interval: "30min" | "1day", from: number, to: number) =>
  db.asRole("eventlens_app", (sql) => readStoredStockWindow(sql, "SPY", interval, { from, to }));

describe("readStoredStockWindow (as the app's role)", () => {
  it("stamps bars like the live client: 30-minute bars at their close, daily bars at 00:00 UTC", async () => {
    await seedBars(db.sql, run, "SPY", "30min", [
      { start: OPEN, end: OPEN + HALF_HOUR_MS, close: 680 },
      { start: OPEN + HALF_HOUR_MS, end: OPEN + HOUR_MS, close: 681 },
    ]);
    await seedBars(db.sql, run, "SPY", "1day", [{ start: DATE, end: DATE + 21 * HOUR_MS, close: 682 }]);
    await seedCoverage(db.sql, run, "twelve_data", "SPY", "30min", DATE, DATE + DAY_MS);
    await seedCoverage(db.sql, run, "twelve_data", "SPY", "1day", DATE, DATE + DAY_MS);

    expect(await read("30min", DATE, DATE + DAY_MS)).toEqual({
      bars: [
        { t: OPEN + HALF_HOUR_MS, open: 680, high: 680, low: 680, close: 680, volume: 1000 },
        { t: OPEN + HOUR_MS, open: 681, high: 681, low: 681, close: 681, volume: 1000 },
      ],
      exchangeTimeZone: "America/New_York",
    });
    expect((await read("1day", DATE, DATE + DAY_MS))?.bars).toEqual([{ t: DATE, open: 682, high: 682, low: 682, close: 682, volume: 1000 }]);
  });

  it("returns nothing unless the whole window was fetched", async () => {
    await seedBars(db.sql, run, "SPY", "30min", [{ start: OPEN, end: OPEN + HALF_HOUR_MS, close: 680 }]);
    await seedCoverage(db.sql, run, "twelve_data", "SPY", "30min", DATE, DATE + 12 * HOUR_MS);

    expect(await read("30min", DATE, DATE + DAY_MS)).toBeNull();
    expect(await read("1day", DATE, DATE + DAY_MS)).toBeNull();
    expect(await read("30min", DATE, DATE + 12 * HOUR_MS)).toEqual({ bars: [], exchangeTimeZone: undefined });
  });
});
