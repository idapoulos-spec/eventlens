import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { seedCandles, seedCoverage, seedMarket, seedRun } from "@/lib/history/test-fixtures";
import { createTestDb, type TestDb } from "@/lib/store/test-db";
import { readStoredHistory, readStoredOutcomes } from "./store";

const EVENT = "KXFEDDECISION-25DEC";
const HOUR = 60 * 60 * 1000;
const T0 = Date.UTC(2025, 9, 1, 14);
const h = (n: number) => T0 + n * HOUR;

let db: TestDb;

beforeEach(async () => {
  db = await createTestDb();
});
afterEach(() => db.close());

const asApp = <T>(fn: (sql: Parameters<Parameters<TestDb["asRole"]>[1]>[0]) => Promise<T>) => db.asRole("eventlens_app", fn);

describe("stored event reads (as the app's role)", () => {
  it("reads an event's outcomes by ticker, and nothing for one that isn't stored", async () => {
    await seedMarket(db.sql, { ticker: `${EVENT}-H0`, status: "finalized", openTime: h(-100), closeTime: h(100), raw: { yes_sub_title: "Fed maintains rate" } });
    await seedMarket(db.sql, { ticker: `${EVENT}-C25`, status: "finalized", openTime: h(-100), closeTime: h(100) });
    await seedMarket(db.sql, { ticker: "KXFEDDECISION-26JAN-H0", status: "active" });

    const outcomes = await asApp((sql) => readStoredOutcomes(sql, EVENT));
    expect(outcomes.map((o) => [o.ticker, o.status, o.openTime, o.closeTime])).toEqual([
      [`${EVENT}-C25`, "finalized", h(-100), h(100)],
      [`${EVENT}-H0`, "finalized", h(-100), h(100)],
    ]);
    expect(outcomes[1].raw.yes_sub_title).toBe("Fed maintains rate");
    expect(await asApp((sql) => readStoredOutcomes(sql, "KXFEDDECISION-99JAN"))).toEqual([]);
  });

  it("reads each outcome's books in the range, its last usable estimate before it, and its merged coverage", async () => {
    const run = await seedRun(db.sql);
    const h0 = await seedMarket(db.sql, { ticker: `${EVENT}-H0`, status: "finalized" });
    const c25 = await seedMarket(db.sql, { ticker: `${EVENT}-C25`, status: "finalized" });
    const h25 = await seedMarket(db.sql, { ticker: `${EVENT}-H25`, status: "finalized" });
    await seedCandles(db.sql, run, h0, [
      { t: h(-5), bid: 0.6, ask: 0.64 },
      // Usable books before the range: the latest one is the seed, not this crossed or empty one.
      { t: h(-3), bid: 0.7, ask: 0.6 },
      { t: h(-2), ask: 1 },
      { t: h(1), bid: 0.8, ask: 0.82 },
      { t: h(20), bid: 0.9, ask: 0.92 },
    ]);
    // Only one side quoted before the range: half the ask (rule 2) or halfway to $1 (rule 3).
    await seedCandles(db.sql, run, c25, [{ t: h(-4), ask: 0.1 }]);
    await seedCandles(db.sql, run, h25, [{ t: h(-4), bid: 0.9 }, { t: h(-1), bid: 0 }]);
    await seedCoverage(db.sql, run, "kalshi", `${EVENT}-H0`, "60", h(-10), h(5));
    await seedCoverage(db.sql, run, "kalshi", `${EVENT}-H0`, "60", h(5), h(8));
    await seedCoverage(db.sql, run, "kalshi", `${EVENT}-H0`, "60", h(12), h(30));
    await seedCoverage(db.sql, run, "kalshi", "KXFEDDECISION-26JAN-H0", "60", h(0), h(30));

    const stored = await asApp((sql) => readStoredHistory(sql, EVENT, { from: h(0), to: h(10) }));
    expect(stored.candles.get(`${EVENT}-H0`)).toEqual([{ endTs: h(1), bid: 0.8, ask: 0.82 }]);
    expect(stored.candles.has(`${EVENT}-C25`)).toBe(false);
    expect(stored.seeds).toEqual(
      new Map([
        [`${EVENT}-H0`, 0.62],
        [`${EVENT}-C25`, 0.05],
        [`${EVENT}-H25`, 0.95],
      ]),
    );
    expect(stored.covered).toEqual(
      new Map([
        [
          `${EVENT}-H0`,
          [
            { from: h(-10), to: h(8) },
            { from: h(12), to: h(30) },
          ],
        ],
      ]),
    );
  });
});
