import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RawMarket } from "@/lib/kalshi/types";
import { getAppSql } from "@/lib/store/db";
import { createTestDb, type TestDb } from "@/lib/store/test-db";
import { findKalshiMarket, researchWindowOf } from "./market";
import { seedMarket } from "./test-fixtures";
import { paths, stubKalshi } from "./test-kalshi";
import { LIVE_WINDOW } from "./window";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/store/db", () => ({ getAppSql: vi.fn(() => null) }));
const appSql = vi.mocked(getAppSql);

const TICKER = "KXFEDDECISION-25DEC-H0";
const CLOSE = "2025-12-10T19:00:00Z";
const archived: RawMarket = { ticker: TICKER, event_ticker: "KXFEDDECISION-25DEC", status: "finalized", result: "yes", close_time: CLOSE };
const NOT_FOUND = `No Kalshi market found with ticker "${TICKER}". Use a market ticker, not an event or series ticker.`;

let db: TestDb;

beforeEach(async () => {
  db = await createTestDb();
});
afterEach(async () => {
  appSql.mockReset();
  appSql.mockReturnValue(null);
  vi.unstubAllGlobals();
  await db.close();
});

/** Runs `fn` with the store on, reading as the app's role. */
const withStore = <T,>(fn: () => Promise<T>) =>
  db.asRole("eventlens_app", (sql) => {
    appSql.mockReturnValue(sql);
    return fn();
  });

describe("findKalshiMarket", () => {
  it("uses the live market when Kalshi has it", async () => {
    const calls = stubKalshi(TICKER, { live: { ...archived, status: "active" }, archive: archived });
    const found = await withStore(() => findKalshiMarket(TICKER));
    expect(found).toMatchObject({ ok: true, data: { archived: false, market: { status: "active" } } });
    expect(paths(calls)).toEqual([`/markets/${TICKER}`]);
  });

  it("without the store, says a 404 market isn't found, as before, and asks nothing else", async () => {
    const calls = stubKalshi(TICKER, { archive: archived });
    expect(await findKalshiMarket(TICKER)).toEqual({ ok: false, error: { code: "not_found", message: NOT_FOUND } });
    expect(paths(calls)).toEqual([`/markets/${TICKER}`]);
  });

  it("with the store, finds a settled market the live endpoints no longer serve in the store", async () => {
    await seedMarket(db.sql, { ticker: TICKER, status: "finalized", closeTime: Date.parse(CLOSE), raw: { result: "yes" } });
    const calls = stubKalshi(TICKER, { archive: 500 });
    const found = await withStore(() => findKalshiMarket(TICKER));
    expect(found).toMatchObject({ ok: true, data: { archived: true, market: { ticker: TICKER, status: "finalized", result: "yes", closeTime: new Date(CLOSE).toISOString() } } });
    expect(paths(calls)).toEqual([`/markets/${TICKER}`]);
  });

  it("goes to the archive when the stored row isn't settled, or the market isn't stored", async () => {
    await seedMarket(db.sql, { ticker: TICKER, status: "active" });
    const calls = stubKalshi(TICKER, { archive: archived });
    expect(await withStore(() => findKalshiMarket(TICKER))).toMatchObject({ ok: true, data: { archived: true, market: { status: "finalized" } } });
    expect(paths(calls)).toEqual([`/markets/${TICKER}`, `/historical/markets/${TICKER}`]);
  });

  it("says a market in neither place isn't found, in the live lookup's words", async () => {
    stubKalshi(TICKER, {});
    expect(await withStore(() => findKalshiMarket(TICKER))).toEqual({ ok: false, error: { code: "not_found", message: NOT_FOUND } });
  });

  it("doesn't look further when the live lookup fails for another reason", async () => {
    const calls = stubKalshi(TICKER, { live: 429, archive: archived });
    expect(await withStore(() => findKalshiMarket(TICKER))).toMatchObject({ ok: false, error: { code: "rate_limited" } });
    expect(paths(calls)).toEqual([`/markets/${TICKER}`]);
  });
});

describe("researchWindowOf", () => {
  it("resolves at once to now without the store, never waiting for the market", async () => {
    expect(await researchWindowOf(new Promise(() => {}))).toEqual(LIVE_WINDOW);
  });

  it("with the store, ends at a closed market's close, or now", async () => {
    appSql.mockReturnValue(db.sql);
    const market = (closeTime: string, archivedMarket: boolean) =>
      Promise.resolve({ ok: true as const, data: { market: { closeTime } as never, archived: archivedMarket } });
    expect(await researchWindowOf(market(CLOSE, true))).toEqual({ end: Date.parse(CLOSE), archived: true });
    expect(await researchWindowOf(market("2099-01-01T00:00:00Z", false))).toEqual(LIVE_WINDOW);
    expect(await researchWindowOf(Promise.resolve({ ok: false, error: { code: "timeout", message: "" } }))).toEqual(LIVE_WINDOW);
  });
});
