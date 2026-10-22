import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RawMarket } from "@/lib/kalshi/types";
import { seedMarket } from "@/lib/history/test-fixtures";
import { createTestDb, type TestDb } from "@/lib/store/test-db";
import type * as Candidates from "./candidates";

vi.mock("server-only", () => ({}));
const appSql = vi.hoisted(() => vi.fn());
vi.mock("@/lib/store/db", () => ({ getAppSql: appSql }));

const NOW = Date.UTC(2026, 9, 21, 18);
const iso = (ms: number) => new Date(ms).toISOString();

function market(ticker: string, event: string, { open = Date.UTC(2026, 0, 5), close = Date.UTC(2026, 11, 1), volume = "0.00", label = ticker }: { open?: number; close?: number; volume?: string; label?: string } = {}): RawMarket {
  return { ticker, event_ticker: event, title: `${event}?`, yes_sub_title: label, status: "active", open_time: iso(open), close_time: iso(close), volume_fp: volume };
}

let c: typeof Candidates;
let db: TestDb;

beforeEach(async () => {
  vi.resetModules();
  c = await import("./candidates");
  db = await createTestDb();
  appSql.mockReturnValue(null);
});

afterEach(async () => {
  vi.unstubAllGlobals();
  appSql.mockReset();
  await db.close();
});

describe("eventCandidate: one test per event", () => {
  it("tests a Fed decision event on its expected value, ending at its first close once passed", () => {
    const markets = [market("KXFEDDECISION-25DEC-H0", "KXFEDDECISION-25DEC", { close: Date.UTC(2025, 11, 10, 19) }), market("KXFEDDECISION-25DEC-C25", "KXFEDDECISION-25DEC", { open: Date.UTC(2025, 2, 3), close: Date.UTC(2025, 11, 10, 19) })];
    const r = c.eventCandidate({ ticker: "KXFEDDECISION-25DEC", series: "KXFEDDECISION", title: "Fed decision in Dec 2025", markets }, true, NOW);
    expect(r.ok && r.data).toMatchObject({ ticker: "KXFEDDECISION-25DEC", kind: "event", end: Date.UTC(2025, 11, 10, 19), start: Date.UTC(2025, 2, 3), picked: null, stored: true });
  });

  it("tests a one-market event on that market", () => {
    const r = c.eventCandidate({ ticker: "KXRECSSNBER-26", series: "KXRECSSNBER", title: "Recession in 2026?", markets: [market("KXRECSSNBER-26", "KXRECSSNBER-26")] }, false, NOW);
    expect(r.ok && r.data).toMatchObject({ ticker: "KXRECSSNBER-26", kind: "market", event: "KXRECSSNBER-26", picked: null, end: null });
  });

  it("tests any other event on its outcome with the highest lifetime volume, ties to the first ticker", () => {
    const markets = [market("KXCPI-26OCT-T0.2", "KXCPI-26OCT", { volume: "120.00" }), market("KXCPI-26OCT-T0.3", "KXCPI-26OCT", { volume: "950.00", label: "Above 0.3%" }), market("KXCPI-26OCT-T0.4", "KXCPI-26OCT", { volume: "950.00" })];
    const r = c.eventCandidate({ ticker: "KXCPI-26OCT", series: "KXCPI", title: "CPI in October", markets }, false, NOW);
    expect(r.ok && r.data).toMatchObject({ ticker: "KXCPI-26OCT-T0.3", kind: "market", label: "Above 0.3%", picked: { outcomes: 3 } });
    // Kalshi's older integer field counts when the fixed-point one is missing.
    expect(c.pickOutcome([markets[0], { ...markets[1], ticker: "KXCPI-26OCT-OLD", volume_fp: undefined, volume: 5_000 }]).ticker).toBe("KXCPI-26OCT-OLD");
  });

  it("ends a market's window at its close only with the store on, as its page does", () => {
    const m = market("KXCPI-25SEP", "KXCPI-25SEP", { close: Date.UTC(2025, 9, 1) });
    const on = c.eventCandidate({ ticker: "KXCPI-25SEP", series: "KXCPI", title: "CPI", markets: [m] }, true, NOW, true);
    const off = c.eventCandidate({ ticker: "KXCPI-25SEP", series: "KXCPI", title: "CPI", markets: [m] }, true, NOW, false);
    expect(on.ok && on.data.end).toBe(Date.UTC(2025, 9, 1));
    expect(off.ok && off.data.end).toBeNull();
  });

  it("can't test an event with no markets", () => {
    expect(c.eventCandidate({ ticker: "KXX-1", series: "KXX", title: "X", markets: [] }, false, NOW).ok).toBe(false);
  });
});

describe("seriesCandidates", () => {
  it("lists a series' open events, one candidate each, earliest close first", async () => {
    const calls: string[] = [];
    vi.stubGlobal("fetch", async (input: string | URL) => {
      const url = new URL(String(input));
      calls.push(`${url.pathname} ${url.searchParams.get("series_ticker")} ${url.searchParams.get("status")}`);
      return Response.json({
        events: [
          { event_ticker: "KXCPI-26NOV", series_ticker: "KXCPI", title: "CPI in November", markets: [market("KXCPI-26NOV-T0.3", "KXCPI-26NOV", { close: Date.UTC(2026, 11, 10) })] },
          { event_ticker: "KXCPI-26OCT", series_ticker: "KXCPI", title: "CPI in October", markets: [market("KXCPI-26OCT-T0.2", "KXCPI-26OCT", { close: Date.UTC(2026, 10, 12), volume: "3.00" }), market("KXCPI-26OCT-T0.3", "KXCPI-26OCT", { close: Date.UTC(2026, 10, 12), volume: "9.00" })] },
        ],
        cursor: "",
      });
    });
    const list = await c.seriesCandidates("KXCPI", { settled: false }, NOW);
    expect(calls).toEqual(["/trade-api/v2/events KXCPI open"]);
    expect(list.ok && list.data.candidates.map((x) => x.ticker)).toEqual(["KXCPI-26NOV-T0.3", "KXCPI-26OCT-T0.3"]);
    expect(list.ok && list.data.truncated).toBe(false);
  });
});

describe("storedCandidates", () => {
  it("lists every stored event, settled ones included, from the store alone", async () => {
    for (const [ticker, event, close] of [
      ["KXFEDDECISION-25DEC-H0", "KXFEDDECISION-25DEC", Date.UTC(2025, 11, 10, 19)],
      ["KXFEDDECISION-25DEC-C25", "KXFEDDECISION-25DEC", Date.UTC(2025, 11, 10, 19)],
      ["KXFEDDECISION-26DEC-H0", "KXFEDDECISION-26DEC", Date.UTC(2026, 11, 9, 19)],
    ] as const) {
      await seedMarket(db.sql, { ticker, status: close < NOW ? "finalized" : "active", openTime: Date.UTC(2025, 2, 3), closeTime: close, raw: market(ticker, event, { open: Date.UTC(2025, 2, 3), close }) });
    }
    vi.stubGlobal("fetch", async () => {
      throw new Error("no live requests");
    });
    const list = await db.asRole("eventlens_app", (sql) => {
      appSql.mockReturnValue(sql);
      return c.storedCandidates(null, NOW);
    });
    expect(list.ok && list.data.candidates.map((x) => [x.ticker, x.kind, x.end])).toEqual([
      ["KXFEDDECISION-25DEC", "event", Date.UTC(2025, 11, 10, 19)],
      ["KXFEDDECISION-26DEC", "event", null],
    ]);
  });

  it("says so without a store", async () => {
    const list = await c.storedCandidates(null, NOW);
    expect(!list.ok && list.error.code).toBe("no_store");
  });
});
