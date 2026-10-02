import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { realizedVolatility } from "@/lib/analytics";
import type { getStockOverview as GetStockOverview } from "./twelve-data";

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
  const requests: URL[] = [];
  const daily = [
    ...pastCloses.map((close, i) => ({ t: TODAY_MS - (pastCloses.length - i) * DAY_MS, close })),
    { t: TODAY_MS, close: 150 },
  ];
  vi.stubGlobal("fetch", async (input: string | URL) => {
    const url = new URL(String(input));
    requests.push(url);
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
        : // Today's first three half hours, 9:30–11:00 New York.
          ["13:30", "14:00", "14:30"].map((time, i) => ({
            datetime: `${TODAY} ${time}:00`,
            open: String(149 + i),
            high: String(151 + i),
            low: String(148 + i),
            close: String(150 + i),
            volume: "1000",
          }));
    // Twelve Data returns the newest bar first.
    return Response.json({ status: "ok", meta: { exchange_timezone: "America/New_York" }, values: values.reverse() });
  });
  return requests;
}

// Price history is kept in the module's memory, so each test loads a fresh copy.
let getStockOverview: typeof GetStockOverview;

beforeEach(async () => {
  vi.stubEnv("TWELVE_DATA_API_KEY", "test-key");
  vi.resetModules();
  ({ getStockOverview } = await import("./twelve-data"));
});

afterEach(() => {
  vi.useRealTimers();
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

  it("requests half-hour bars and combines them into hourly bars for the comparison chart", async () => {
    const requests = stubTwelveData({ isMarketOpen: true });
    const data = await overview();

    const series = requests.filter((u) => u.pathname === "/time_series").map((u) => u.searchParams.get("interval"));
    expect(series.sort()).toEqual(["1day", "30min"]);
    expect(requests).toHaveLength(3);
    // 9:30, 10:00, and 10:30 bars, stamped at their close times.
    expect(data.halfHourly.map((b) => b.t)).toEqual(["14:00", "14:30", "15:00"].map((t) => Date.parse(`${TODAY}T${t}:00Z`)));
    // 9:30–10:30 and the still-forming 10:30–11:30 hour, stamped like Twelve Data's own hourly bars.
    expect(data.intraday).toEqual([
      { t: Date.parse(`${TODAY}T14:30:00Z`), open: 149, high: 152, low: 148, close: 151, volume: 2000 },
      { t: Date.parse(`${TODAY}T15:30:00Z`), open: 151, high: 153, low: 150, close: 152, volume: 1000 },
    ]);
  });

  it("keeps every bar when the quote doesn't say which session it is for", async () => {
    stubTwelveData({ isMarketOpen: true, datetime: "" });
    expect((await overview()).daily).toHaveLength(41);
  });
});

describe("getStockOverview price history", () => {
  const HALF_HOUR_MS = 30 * 60 * 1000;
  const at = (iso: string) => Date.parse(iso);
  const datetime = (ms: number) => new Date(ms).toISOString().slice(0, 19).replace("T", " ");

  /**
   * Fakes Twelve Data as of the current (fake) time: today's 30-minute bars that have opened
   * (9:30 AM–4:00 PM New York, during daylight time), and daily bars for the last three days
   * including today. Requests made with Next.js's time-based cache are answered the way its
   * data cache answers them: with the stored response, however old, refreshed in the background.
   */
  function stubLiveTwelveData(isMarketOpen: () => boolean) {
    const requests: { url: URL; init?: RequestInit & { next?: { revalidate?: number } } }[] = [];
    const nextDataCache = new Map<string, unknown>();
    function body(url: URL) {
      const now = Date.now();
      const today = new Date(now).toISOString().slice(0, 10);
      if (url.pathname === "/quote") return { symbol: "NVDA", close: "150", datetime: today, is_market_open: isMarketOpen() };
      if (url.searchParams.get("interval") === "1day") {
        const days = [0, 1, 2].map((d) => new Date(at(`${today}T00:00:00Z`) - d * DAY_MS).toISOString().slice(0, 10));
        return { status: "ok", values: days.map((d, i) => ({ datetime: d, open: "1", high: "1", low: "1", close: String(150 - i) })) };
      }
      const opens: number[] = [];
      for (let t = at(`${today}T13:30:00Z`); t <= now && t < at(`${today}T20:00:00Z`); t += HALF_HOUR_MS) opens.push(t);
      return {
        status: "ok",
        meta: { exchange_timezone: "America/New_York" },
        values: opens.reverse().map((t) => ({ datetime: datetime(t), open: "1", high: "1", low: "1", close: "1", volume: "1" })),
      };
    }
    vi.stubGlobal("fetch", async (input: string | URL, init?: RequestInit & { next?: { revalidate?: number } }) => {
      const url = new URL(String(input));
      requests.push({ url, init });
      if (init?.next?.revalidate !== undefined && init.cache !== "no-store") {
        const stored = nextDataCache.get(url.href);
        nextDataCache.set(url.href, body(url));
        if (stored) return Response.json(stored);
      }
      return Response.json(body(url));
    });
    return requests;
  }

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
  });

  it("never shows bars from before a quiet period as current", async () => {
    const requests = stubLiveTwelveData(() => true);
    vi.setSystemTime(at("2026-09-28T17:12:00Z")); // Mon 1:12 PM New York
    await overview();

    vi.setSystemTime(at("2026-10-02T18:50:00Z")); // Four days later, Fri 2:50 PM
    const data = await overview();
    // Today's still-forming 2:30–3:00 PM bar, not Monday's 1:00–1:30 PM bar.
    expect(new Date(data.halfHourly.at(-1)!.t).toISOString()).toBe("2026-10-02T19:00:00.000Z");
    expect(data.daily.at(-1)!.t).toBe(at("2026-10-01T00:00:00Z"));
    expect(data.historyFetchedAt).toBe(at("2026-10-02T18:50:00Z"));
    const series = requests.filter((r) => r.url.pathname === "/time_series");
    expect(series).toHaveLength(4);
    expect(series.every((r) => r.init?.cache === "no-store" && r.init.next === undefined)).toBe(true);
  });

  it("reuses price history for a minute after fetching it, then fetches it again", async () => {
    const requests = stubLiveTwelveData(() => true);
    vi.setSystemTime(at("2026-10-02T18:50:00Z"));
    await overview();
    expect(requests).toHaveLength(3);

    vi.setSystemTime(at("2026-10-02T18:50:59Z"));
    const reused = await overview();
    expect(requests).toHaveLength(4); // the quote only
    expect(reused.historyFetchedAt).toBe(at("2026-10-02T18:50:00Z"));

    vi.setSystemTime(at("2026-10-02T18:51:00Z"));
    expect((await overview()).historyFetchedAt).toBe(at("2026-10-02T18:51:00Z"));
    expect(requests).toHaveLength(7);
  });

  it("leaves out a day whose bars were fetched before its session closed", async () => {
    let open = true;
    stubLiveTwelveData(() => open);
    vi.setSystemTime(at("2026-10-02T19:59:30Z")); // 3:59:30 PM
    expect((await overview()).daily.at(-1)!.t).toBe(at("2026-10-01T00:00:00Z"));

    // After the close the quote says so, but the bars in memory are from before it.
    open = false;
    vi.setSystemTime(at("2026-10-02T20:00:20Z"));
    expect((await overview()).daily.at(-1)!.t).toBe(at("2026-10-01T00:00:00Z"));

    vi.setSystemTime(at("2026-10-02T20:01:30Z"));
    expect((await overview()).daily.at(-1)).toMatchObject({ t: at("2026-10-02T00:00:00Z"), close: 150 });
  });
});

