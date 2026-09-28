import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { realizedVolatility } from "@/lib/analytics";
import { getStockOverview } from "./twelve-data";

// server-only throws outside React's server environment; the client only uses it as a marker.
vi.mock("server-only", () => ({}));

const TODAY = "2026-09-28";
const TODAY_MS = Date.parse(`${TODAY}T00:00:00Z`);
const DAY_MS = 24 * 60 * 60 * 1000;

/** 40 completed sessions before today with gently varying closes, oldest first. */
const pastCloses = Array.from({ length: 40 }, (_, i) => 100 + (i % 5) - 2);

interface Quote {
  isMarketOpen: boolean;
  datetime?: string;
  volume?: number;
}

/** Fakes Twelve Data: daily bars end with a bar for today whose close jumps to 150. */
function stubTwelveData({ isMarketOpen, datetime = TODAY, volume = 4_000_000 }: Quote) {
  const daily = [
    ...pastCloses.map((close, i) => ({ t: TODAY_MS - (pastCloses.length - i) * DAY_MS, close })),
    { t: TODAY_MS, close: 150 },
  ];
  vi.stubGlobal("fetch", async (input: string | URL) => {
    const url = new URL(String(input));
    if (url.pathname === "/quote") {
      return Response.json({
        symbol: "NVDA",
        close: "150",
        datetime,
        volume: String(volume),
        average_volume: "200000000",
        is_market_open: isMarketOpen,
      });
    }
    const values =
      url.searchParams.get("interval") === "1day"
        ? daily.map((b) => ({ datetime: new Date(b.t).toISOString().slice(0, 10), open: "1", high: "1", low: "1", close: String(b.close) }))
        : [{ datetime: `${TODAY} 13:30:00`, open: "1", high: "1", low: "1", close: "150" }];
    // Twelve Data returns the newest bar first.
    return Response.json({ status: "ok", meta: { exchange_timezone: "America/New_York" }, values: values.reverse() });
  });
}

beforeEach(() => {
  vi.stubEnv("TWELVE_DATA_API_KEY", "test-key");
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

async function overview() {
  const result = await getStockOverview("NVDA");
  if (!result.ok) throw new Error(`Expected data, got ${result.error.code}`);
  return result.data;
}

describe("getStockOverview", () => {
  it("leaves today's unfinished bar out of daily history and volatility while the market is open", async () => {
    stubTwelveData({ isMarketOpen: true });
    const data = await overview();

    expect(data.daily).toHaveLength(40);
    expect(data.daily.at(-1)!.t).toBe(TODAY_MS - DAY_MS);
    expect(data.realizedVol30d).toBeCloseTo(realizedVolatility(pastCloses.slice(-31))!, 10);
  });

  it("withholds relative volume while the market is open", async () => {
    stubTwelveData({ isMarketOpen: true });
    expect((await overview()).relativeVolume).toBeNull();
  });

  it("includes today's bar and compares volume with the average once the market has closed", async () => {
    stubTwelveData({ isMarketOpen: false, volume: 150_000_000 });
    const data = await overview();

    expect(data.daily).toHaveLength(41);
    expect(data.daily.at(-1)).toMatchObject({ t: TODAY_MS, close: 150 });
    expect(data.realizedVol30d).toBeCloseTo(realizedVolatility([...pastCloses.slice(-30), 150])!, 10);
    expect(data.relativeVolume).toBe(75);
  });

  it("keeps every bar when the quote doesn't say which session it is for", async () => {
    stubTwelveData({ isMarketOpen: true, datetime: "" });
    expect((await overview()).daily).toHaveLength(41);
  });
});
