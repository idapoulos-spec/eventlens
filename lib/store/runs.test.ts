import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { coveredUntil, findGaps, finishRun, recordCoverage, startRun, type SeriesRef } from "./runs";
import { createTestDb, type TestDb } from "./test-db";

const HOUR = 60 * 60 * 1000;
const T0 = Date.UTC(2026, 9, 1);
const at = (hours: number) => T0 + hours * HOUR;
const SERIES: SeriesRef = { source: "kalshi", seriesKey: "KXTEST-26OCT-H0", interval: "60" };

let db: TestDb;

beforeEach(async () => {
  db = await createTestDb();
});
afterEach(() => db.close());

describe("collection runs", () => {
  it("records a run from start to finish", async () => {
    const id = await startRun(db.sql, { collector: "kalshi", mode: "incremental", trigger: "schedule" });
    await finishRun(db.sql, id, { status: "ok", requests: 7, credits: 0, rowsInserted: 120, rowsChanged: 2 });
    const [run] = await db.sql.query("select status, requests, rows_inserted, rows_changed, error, finished_at is not null as finished from collection_runs");
    expect(run).toEqual({ status: "ok", requests: 7, rows_inserted: 120, rows_changed: 2, error: null, finished: true });
  });

  it("finishes a run only once", async () => {
    const id = await startRun(db.sql, { collector: "stocks", mode: "backfill", trigger: "local" });
    const result = { status: "failed", requests: 1, credits: 1, rowsInserted: 0, rowsChanged: 0, error: "Rate limited" } as const;
    await finishRun(db.sql, id, result);
    await expect(finishRun(db.sql, id, result)).rejects.toThrow(/isn't running/);
  });
});

describe("coverage and gaps", () => {
  let runId: number;
  beforeEach(async () => {
    runId = await startRun(db.sql, { collector: "kalshi", mode: "backfill", trigger: "local" });
  });

  const cover = (from: number, to: number, series = SERIES) => recordCoverage(db.sql, runId, series, { from: at(from), to: at(to) }, 0);
  const gaps = async (from: number, to: number) =>
    (await findGaps(db.sql, SERIES, { from: at(from), to: at(to) })).map((g) => [(g.from - T0) / HOUR, (g.to - T0) / HOUR]);

  it("finds the whole range missing when nothing was fetched", async () => {
    expect(await gaps(0, 24)).toEqual([[0, 24]]);
    expect(await coveredUntil(db.sql, SERIES)).toBeNull();
  });

  it("merges overlapping and adjacent ranges, and leaves only what none covers", async () => {
    await cover(0, 6);
    await cover(4, 10); // overlaps
    await cover(10, 12); // adjacent: half-open ranges leave no gap at 10
    await cover(15, 20);
    await cover(30, 40); // outside the range asked about
    expect(await gaps(0, 24)).toEqual([
      [12, 15],
      [20, 24],
    ]);
    expect(await gaps(2, 11)).toEqual([]);
    expect(await coveredUntil(db.sql, SERIES)).toBe(at(40));
  });

  it("counts only coverage of the same series and interval", async () => {
    await cover(0, 24, { ...SERIES, interval: "1440" });
    await cover(0, 24, { ...SERIES, seriesKey: "KXTEST-26OCT-H25" });
    expect(await gaps(0, 24)).toEqual([[0, 24]]);
  });

  it("rejects an empty or reversed range", async () => {
    await expect(cover(5, 5)).rejects.toThrow(/Invalid time range/);
    await expect(findGaps(db.sql, SERIES, { from: at(5), to: at(1) })).rejects.toThrow(/Invalid time range/);
  });
});

describe("the schema's constraints", () => {
  async function insertCandle(fields: Record<string, unknown> = {}) {
    const [run] = await db.sql.query<{ id: number }>(
      "insert into collection_runs (collector, mode, trigger) values ('kalshi', 'backfill', 'local') returning id",
    );
    await db.sql.query(
      `insert into kalshi_markets (ticker, event_ticker, series_ticker, status, source, raw)
       values ('KXTEST-26OCT-H0', 'KXTEST-26OCT', 'KXTEST', 'active', 'live', '{}') on conflict do nothing`,
    );
    const row = { period_min: 60, end_ts: new Date(T0), yes_bid_close: 450000, volume: 1000, ...fields };
    const columns = Object.keys(row);
    await db.sql.query(
      `insert into kalshi_candles (market_id, ${columns.join(", ")}, source, fetched_at, run_id)
       select id, ${columns.map((_, i) => `$${i + 1}`).join(", ")}, 'live', now(), $${columns.length + 1}
         from kalshi_markets where ticker = 'KXTEST-26OCT-H0'`,
      [...Object.values(row), run.id],
    );
  }

  it("keeps one candle per market, period, and end time", async () => {
    await insertCandle();
    await expect(insertCandle()).rejects.toThrow(/duplicate key/);
    await insertCandle({ period_min: 1440 });
  });

  it("rejects prices outside $0–$1, negative counts, and unknown periods", async () => {
    await expect(insertCandle({ yes_bid_close: 1_000_001 })).rejects.toThrow(/micro_dollars/);
    await expect(insertCandle({ yes_bid_close: -1 })).rejects.toThrow(/micro_dollars/);
    await expect(insertCandle({ volume: -100 })).rejects.toThrow(/hundredths/);
    await expect(insertCandle({ period_min: 1 })).rejects.toThrow(/check constraint/);
  });

  it("keeps one watchlist entry per kind and key, with intervals that fit the kind", async () => {
    const add = (kind: string, key: string, intervals: string[]) =>
      db.sql.query("insert into watchlist (kind, key, intervals) values ($1, $2, $3)", [kind, key, intervals]);
    await expect(add("stock", "SPY", ["1day"])).rejects.toThrow(/duplicate key/);
    await expect(add("stock", "IBM", ["60"])).rejects.toThrow(/check constraint/);
    await expect(add("kalshi_market", "KXTEST-26OCT-H0", ["30min"])).rejects.toThrow(/check constraint/);
    await expect(add("stock", "ibm", ["1day"])).rejects.toThrow(/check constraint/);
    await add("stock", "IBM", ["1day"]);
  });
});
