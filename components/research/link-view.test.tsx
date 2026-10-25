// Research opens with every setting a link carries, from the fake world through the real loaders
// and components, as the server renders it: the window, resolution, returns, benchmark (loaded by
// the server in place of SPY), jump size, and a frozen link's as-of time.

import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ResearchView } from "@/lib/history/window";
import type { loadAnalysis as LoadAnalysis } from "@/lib/history/analysis";
import type { loadEventAnalysis as LoadEventAnalysis } from "@/lib/expected/load";
import { stubWorld, worldEvent, worldMarket } from "@/lib/history/test-world";
import type { Research as ResearchComponent } from "../Research";
import type { EventResearch as EventResearchComponent } from "../event/EventDashboard";
import { fetchBenchmark } from "./useBenchmark";

vi.setConfig({ testTimeout: 60_000 });
vi.mock("server-only", () => ({}));
vi.mock("@/lib/store/db", () => ({ getAppSql: () => null }));

// As in the pins: Wednesday, Oct 7, 2026, 12:40 PM New York, the market open.
const NOW = Date.UTC(2026, 9, 7, 16, 40, 30);
const LIVE_MARKET = worldMarket("KXFEDDECISION-26DEC-H0", { status: "active", open: Date.UTC(2025, 4, 1), close: Date.UTC(2026, 11, 9, 19), archived: false });
const LONG_EVENT = worldEvent("KXFEDDECISION-26DEC", { status: "active", open: Date.UTC(2025, 5, 2, 14), close: Date.UTC(2026, 11, 9, 19), archived: false }, { bounded: true });

let loadAnalysis: typeof LoadAnalysis;
let loadEventAnalysis: typeof LoadEventAnalysis;
let Research: typeof ResearchComponent;
let EventResearch: typeof EventResearchComponent;

beforeEach(async () => {
  vi.stubEnv("TWELVE_DATA_API_KEY", "test-key");
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  vi.resetModules();
  ({ loadAnalysis } = await import("@/lib/history/analysis"));
  ({ loadEventAnalysis } = await import("@/lib/expected/load"));
  ({ Research } = await import("../Research"));
  ({ EventResearch } = await import("../event/EventDashboard"));
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

/** The market page's Research section for a link's view, as Dashboard loads it. */
async function marketMarkup(view: ResearchView): Promise<string> {
  const stock = "NVDA";
  const kalshi = LIVE_MARKET.ticker;
  const { kalshiData, stockData, researchHistory, benchmarkData, longHistory } = loadAnalysis(stock, kalshi, {
    asOf: view.asOf ?? null,
    ...(view.benchmark && { benchmark: view.benchmark }),
  });
  const html = renderToStaticMarkup(await Research({ kalshiData, stockData, historyData: researchHistory, longData: longHistory, benchmarkData, stock, kalshi, view }));
  await longHistory;
  return html;
}

/** Which option of a segmented control is pressed. */
const pressed = (html: string, group: string) => new RegExp(`aria-label="${group}"[^>]*>(?:(?!</div>).)*?aria-pressed="true"[^>]*>([^<]+)<`).exec(html)?.[1];
const selectedJump = (html: string) => /<option value="([^"]+)" selected="">/.exec(html)?.[1];

describe("Research opens as its link says", () => {
  it("with the defaults when the link carries no settings", async () => {
    stubWorld([LIVE_MARKET]);
    const html = await marketMarkup({ window: null, resolution: null });
    expect(pressed(html, "Window")).toBe("90D");
    expect(pressed(html, "Resolution")).toBe("Hourly");
    expect(pressed(html, "Returns")).toBe("Market-adjusted");
    expect(selectedJump(html)).toBe("2");
    expect(html).toContain("<section data-report-controls");
    expect(html).toContain("Windows end now (Oct 7, 2026, 12:40 PM EDT), so the numbers change as new data arrives.");
    expect(html).toContain("Freeze at this view’s time");
  });

  it("with its window, resolution, returns, and jump size", async () => {
    stubWorld([LIVE_MARKET]);
    const html = await marketMarkup({ window: 30, resolution: "daily", returns: "raw", jump: 10 });
    expect(pressed(html, "Window")).toBe("30D");
    expect(pressed(html, "Resolution")).toBe("Daily");
    expect(pressed(html, "Returns")).toBe("Raw");
    expect(selectedJump(html)).toBe("10");
  });

  it("ignores a jump size the variable doesn't offer", async () => {
    stubWorld([LIVE_MARKET]);
    expect(selectedJump(await marketMarkup({ window: null, resolution: null, jump: 7 }))).toBe("2");
  });

  it("with its benchmark, which the server loads in place of SPY", async () => {
    const requests = stubWorld([LIVE_MARKET]);
    const html = await marketMarkup({ window: null, resolution: null, benchmark: "QQQ" });
    expect(html).toContain("(vs. QQQ)");
    expect(html).toContain("market-adjusted vs. QQQ");
    const twelve = requests.filter((r) => r.startsWith("twelvedata"));
    expect(twelve).toHaveLength(5);
    expect(twelve.filter((r) => r.includes("symbol=QQQ"))).toHaveLength(2);
    expect(twelve.some((r) => r.includes("symbol=SPY"))).toBe(false);
  });

  it("frozen at its as-of time, saying so", async () => {
    const asOf = Date.UTC(2026, 9, 5, 18, 2, 10);
    stubWorld([LIVE_MARKET]);
    const html = await marketMarkup({ window: null, resolution: null, asOf });
    expect(html).toContain("in windows ending at the link’s as-of time (Oct 5, 2026, 2:02 PM EDT)");
    expect(html).toContain("Frozen as of Oct 5, 2026, 2:02 PM EDT: this page’s link gives the same numbers later.");
    expect(html).toContain("Go live");
    expect(html).not.toContain("Freeze at this view’s time");
  });

  it("frozen, for a whole event", async () => {
    const asOf = Date.UTC(2026, 9, 5, 18, 2, 10);
    stubWorld(LONG_EVENT);
    const { event, stockData, benchmarkData, long } = loadEventAnalysis("TLT", "KXFEDDECISION-26DEC", { asOf });
    const view = { window: null, resolution: null, asOf };
    const html = renderToStaticMarkup(await EventResearch({ eventData: event, stockData, benchmarkData, longData: long, stock: "TLT", kalshi: "KXFEDDECISION-26DEC", view }));
    await long;
    expect(html).toContain("in windows ending at the link’s as-of time (Oct 5, 2026, 2:02 PM EDT)");
    const e = await event;
    expect(e.ok && e.data.window).toMatchObject({ end: asOf, frozen: true });
  });
});

describe("fetchBenchmark", () => {
  it("asks for a frozen window's benchmark with frozen=1, and only then", async () => {
    const urls: string[] = [];
    vi.stubGlobal("fetch", async (input: string) => {
      urls.push(input);
      return Response.json({ symbol: "QQQ", hourly: [], daily: [], fetchedAt: 1 });
    });
    await fetchBenchmark("QQQ", { end: 1_700_000_000_000, frozen: true });
    await fetchBenchmark("QQQ", { end: 1_700_000_000_000 });
    await fetchBenchmark("QQQ", { frozen: true });
    expect(urls).toEqual([
      "/api/benchmark?symbol=QQQ&end=1700000000000&frozen=1",
      "/api/benchmark?symbol=QQQ&end=1700000000000",
      "/api/benchmark?symbol=QQQ",
    ]);
  });
});
