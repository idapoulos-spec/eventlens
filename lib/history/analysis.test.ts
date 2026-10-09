// Every upstream request one analysis makes: unchanged without the store, and within the usual
// Twelve Data credits for a market settled before Kalshi's archive cutoff with it.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestDb, type TestDb } from "@/lib/store/test-db";
import type { loadAnalysis as LoadAnalysis } from "./analysis";

vi.mock("server-only", () => ({}));
const appSql = vi.hoisted(() => vi.fn());
vi.mock("@/lib/store/db", () => ({ getAppSql: appSql }));

const NOW = Date.UTC(2026, 9, 7, 16, 40, 30);
const END_SEC = Date.UTC(2026, 9, 7, 16, 40) / 1000;
const DAY_SEC = 24 * 60 * 60;
const OPEN_MARKET = "KXFEDDECISION-26OCT-H0";
const SETTLED_MARKET = "KXFEDDECISION-25DEC-H0";
const SETTLED_CLOSE = Date.UTC(2025, 11, 10, 19);

/** One request in a readable form: host, path, and the parameters that tell requests apart. */
function describeRequest(url: URL): string {
  const keep = ["symbol", "interval", "outputsize", "start_date", "end_date", "period_interval", "start_ts", "end_ts"];
  const q = [...url.searchParams].filter(([k]) => keep.includes(k)).map(([k, v]) => `${k}=${v}`);
  const host = url.hostname.includes("kalshi") ? "kalshi" : "twelvedata";
  return `${host} ${url.pathname.replace("/trade-api/v2", "")}${q.length ? ` ${q.join(" ")}` : ""}`;
}

/** Fakes both APIs: Kalshi knows only the open market live and the settled one in its archive. */
function stubUpstreams() {
  const requests: string[] = [];
  vi.stubGlobal("fetch", async (input: string | URL) => {
    const url = new URL(String(input));
    requests.push(describeRequest(url));
    const path = url.pathname.replace("/trade-api/v2", "");
    if (path === `/markets/${OPEN_MARKET}`) {
      return Response.json({ market: { ticker: OPEN_MARKET, event_ticker: "KXFEDDECISION-26OCT", status: "active", close_time: "2026-10-28T18:00:00Z" } });
    }
    if (path === `/historical/markets/${SETTLED_MARKET}`) {
      return Response.json({
        market: { ticker: SETTLED_MARKET, event_ticker: "KXFEDDECISION-25DEC", status: "finalized", close_time: new Date(SETTLED_CLOSE).toISOString() },
      });
    }
    if (path === "/markets/candlesticks") return Response.json({ markets: [] });
    if (path.endsWith("/candlesticks")) return Response.json({ candlesticks: [] });
    if (path === "/markets/trades") return Response.json({ trades: [] });
    if (path === "/quote") return Response.json({ symbol: "NVDA", close: "180", datetime: "2026-10-07", is_market_open: true });
    if (path === "/time_series") {
      const daily = url.searchParams.get("interval") === "1day";
      return Response.json({
        status: "ok",
        meta: { exchange_timezone: "America/New_York" },
        values: [{ datetime: daily ? "2026-10-06" : "2026-10-07 14:00:00", open: "1", high: "1", low: "1", close: "1" }],
      });
    }
    return Response.json({}, { status: 404 });
  });
  return requests;
}

let db: TestDb;
let loadAnalysis: typeof LoadAnalysis;

beforeEach(async () => {
  vi.stubEnv("TWELVE_DATA_API_KEY", "test-key");
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  vi.resetModules();
  ({ loadAnalysis } = await import("./analysis"));
  db = await createTestDb();
  appSql.mockReturnValue(null);
});

afterEach(async () => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  appSql.mockReset();
  await db.close();
});

async function run(stock: string, kalshi: string) {
  const { kalshiData, stockData, researchHistory, benchmarkData } = loadAnalysis(stock, kalshi);
  return Promise.all([kalshiData, stockData, researchHistory, benchmarkData]);
}

const twelveData = (requests: string[]) => requests.filter((r) => r.startsWith("twelvedata"));

describe("loadAnalysis", () => {
  it("without the store, makes exactly the requests the dashboard always has", async () => {
    const requests = stubUpstreams();
    await run("NVDA", OPEN_MARKET);
    const hour = 60 * 60;
    expect(requests.sort()).toEqual(
      [
        `kalshi /markets/${OPEN_MARKET}`,
        "kalshi /markets/trades",
        `kalshi /markets/candlesticks start_ts=${END_SEC - 7 * DAY_SEC} end_ts=${END_SEC} period_interval=60`,
        `kalshi /markets/candlesticks start_ts=${END_SEC - 3 * hour} end_ts=${END_SEC} period_interval=1`,
        `kalshi /markets/candlesticks start_ts=${END_SEC - DAY_SEC - hour} end_ts=${END_SEC - DAY_SEC} period_interval=1`,
        `kalshi /markets/candlesticks start_ts=${END_SEC - 97 * DAY_SEC} end_ts=${END_SEC} period_interval=60`,
        "twelvedata /quote symbol=NVDA",
        "twelvedata /time_series symbol=NVDA interval=30min outputsize=900",
        "twelvedata /time_series symbol=NVDA interval=1day outputsize=90",
        "twelvedata /time_series symbol=SPY interval=30min outputsize=900",
        "twelvedata /time_series symbol=SPY interval=1day outputsize=90",
      ].sort(),
    );
  });

  it("without the store, still can't find a market settled before Kalshi's archive cutoff", async () => {
    const requests = stubUpstreams();
    const [kalshi] = await run("NVDA", SETTLED_MARKET);
    expect(kalshi).toMatchObject({ ok: false, error: { code: "not_found" } });
    expect(requests.some((r) => r.includes("/historical"))).toBe(false);
  });

  it("with the store, studies a settled market ending at its close, for the usual 5 Twelve Data credits", async () => {
    const requests = stubUpstreams();
    const [kalshi, stock, history] = await db.asRole("eventlens_app", (sql) => {
      appSql.mockReturnValue(sql);
      return run("NVDA", SETTLED_MARKET);
    });

    expect(kalshi).toMatchObject({ ok: true, data: { phase: "settled", closePassed: true } });
    expect(stock.ok && stock.data.research.end).toBe(SETTLED_CLOSE);
    expect(history.ok).toBe(true);
    expect(requests).toContain(`kalshi /historical/markets/${SETTLED_MARKET}`);
    expect(requests).toContain(
      `kalshi /historical/markets/${SETTLED_MARKET}/candlesticks start_ts=${SETTLED_CLOSE / 1000 - 97 * DAY_SEC} end_ts=${SETTLED_CLOSE / 1000} period_interval=60`,
    );
    expect(twelveData(requests).sort()).toEqual(
      [
        "twelvedata /quote symbol=NVDA",
        "twelvedata /time_series symbol=NVDA interval=30min outputsize=5000 start_date=2025-09-01 end_date=2025-12-11",
        "twelvedata /time_series symbol=NVDA interval=1day outputsize=5000 start_date=2025-09-01",
        "twelvedata /time_series symbol=SPY interval=30min outputsize=5000 start_date=2025-09-01 end_date=2025-12-11",
        "twelvedata /time_series symbol=SPY interval=1day outputsize=5000 start_date=2025-09-01 end_date=2025-12-11",
      ].sort(),
    );
  });

  it("with the store, an open market's analysis spends the same credits as before", async () => {
    const requests = stubUpstreams();
    await db.asRole("eventlens_app", (sql) => {
      appSql.mockReturnValue(sql);
      return run("NVDA", OPEN_MARKET);
    });
    expect(twelveData(requests).sort()).toEqual(
      [
        "twelvedata /quote symbol=NVDA",
        "twelvedata /time_series symbol=NVDA interval=30min outputsize=900",
        "twelvedata /time_series symbol=NVDA interval=1day outputsize=90",
        "twelvedata /time_series symbol=SPY interval=30min outputsize=900",
        "twelvedata /time_series symbol=SPY interval=1day outputsize=90",
      ].sort(),
    );
  });
});
