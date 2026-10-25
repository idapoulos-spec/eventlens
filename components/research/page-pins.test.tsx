// Pins what the Research panel and the scan's results show today, as markup: rows from the fake
// world through the real loaders and components, rendered as the server renders them. Taken on
// main at v0.12.0 (821869b), before saved studies and reports (feat/reports), so the existing
// cards stay exactly as they were. Controls added later sit in one element marked
// data-report-controls, which these pins leave out.

import { createHash } from "node:crypto";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ResearchView } from "@/lib/history/window";
import { createTestDb, type TestDb } from "@/lib/store/test-db";
import type { loadEventAnalysis as LoadEventAnalysis } from "@/lib/expected/load";
import type { loadAnalysis as LoadAnalysis } from "@/lib/history/analysis";
import { seedCandles, seedCoverage, seedMarket, seedRun } from "@/lib/history/test-fixtures";
import { HOUR_MS, stubWorld, worldEvent, worldMarket, type WorldMarket } from "@/lib/history/test-world";
import type { getScanPrices as GetScanPrices } from "@/lib/scan/prices";
import type { loadCandidateKalshi as LoadCandidateKalshi } from "@/lib/scan/load";
import type { tickerCandidates as TickerCandidates } from "@/lib/scan/candidates";
import { parseSpan } from "@/lib/scan/api";
import { SCAN_CANDIDATE_PATH, SCAN_PRICES_PATH } from "@/lib/scan/types";
import type { ScanRun as ScanRunClass, ScanSnapshot } from "../scan/scanRunner";
import type { Research as ResearchComponent } from "../Research";
import type { EventResearch as EventResearchComponent } from "../event/EventDashboard";
import type { ScanResults as ScanResultsComponent } from "../scan/ScanPage";

vi.setConfig({ testTimeout: 60_000 });
vi.mock("server-only", () => ({}));
const appSql = vi.hoisted(() => vi.fn());
vi.mock("@/lib/store/db", () => ({ getAppSql: appSql }));

// As in research-golden.test.ts: Wednesday, Oct 7, 2026, 12:40 PM New York, the market open.
const NOW = Date.UTC(2026, 9, 7, 16, 40, 30);
const LIVE_MARKET = worldMarket("KXFEDDECISION-26DEC-H0", { status: "active", open: Date.UTC(2025, 4, 1), close: Date.UTC(2026, 11, 9, 19), archived: false });
const SETTLED = { status: "finalized" as const, open: Date.UTC(2025, 2, 3, 14), close: Date.UTC(2025, 11, 10, 19), archived: true };
const SETTLED_MARKET = worldMarket("KXFEDDECISION-25DEC-H0", SETTLED);
const LIVE_EVENT = worldEvent("KXFEDDECISION-26DEC", { status: "active", open: Date.UTC(2025, 5, 2, 14), close: Date.UTC(2026, 11, 9, 19), archived: false });
// As in scanRunner.test.ts: a market of another meeting than the event, so the event's outcomes are its own.
const SCAN_MARKET = worldMarket("KXFEDDECISION-26OCT-H0", { status: "active", open: Date.UTC(2025, 4, 1), close: Date.UTC(2026, 9, 28, 18), archived: false });
const SCAN_EVENT = worldEvent("KXFEDDECISION-26DEC", { status: "active", open: Date.UTC(2025, 5, 2, 14), close: Date.UTC(2026, 11, 9, 19), archived: false }, { bounded: true });

const LINKED: ResearchView = { window: 30, resolution: "daily" };

const sha = (text: string) => createHash("sha256").update(text).digest("hex").slice(0, 16);

/** The markup the pins cover: everything but the controls added for studies and reports. */
export function pinnedMarkup(html: string): string {
  return html.replace(/<section data-report-controls[\s\S]*?<\/section>/g, "");
}

let db: TestDb;
let loadAnalysis: typeof LoadAnalysis;
let loadEventAnalysis: typeof LoadEventAnalysis;
let Research: typeof ResearchComponent;
let EventResearch: typeof EventResearchComponent;
let ScanResults: typeof ScanResultsComponent;
let ScanRun: typeof ScanRunClass;
let getScanPrices: typeof GetScanPrices;
let loadCandidateKalshi: typeof LoadCandidateKalshi;
let tickerCandidates: typeof TickerCandidates;

beforeEach(async () => {
  vi.stubEnv("TWELVE_DATA_API_KEY", "test-key");
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  // Bars and benchmarks are kept in module memory, so each test loads fresh copies.
  vi.resetModules();
  ({ loadAnalysis } = await import("@/lib/history/analysis"));
  ({ loadEventAnalysis } = await import("@/lib/expected/load"));
  ({ Research } = await import("../Research"));
  ({ EventResearch } = await import("../event/EventDashboard"));
  ({ ScanResults } = await import("../scan/ScanPage"));
  ({ ScanRun } = await import("../scan/scanRunner"));
  ({ getScanPrices } = await import("@/lib/scan/prices"));
  ({ loadCandidateKalshi } = await import("@/lib/scan/load"));
  ({ tickerCandidates } = await import("@/lib/scan/candidates"));
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

/** Stores markets, their candles, and coverage from their open through an hour after their close. */
async function store(markets: WorldMarket[]) {
  const run = await seedRun(db.sql);
  for (const m of markets) {
    const id = await seedMarket(db.sql, { ticker: m.ticker, status: m.status, openTime: m.open, closeTime: m.close, raw: m.raw });
    await seedCandles(db.sql, run, id, m.quotes.map((q) => ({ t: q.t, bid: q.bid / 100, ask: q.ask / 100 })));
    await seedCoverage(db.sql, run, "kalshi", m.ticker, "60", m.open, m.close + HOUR_MS);
  }
}

const withStore = <T,>(load: () => Promise<T>) =>
  db.asRole("eventlens_app", (sql) => {
    appSql.mockReturnValue(sql);
    return load();
  });

/** A market's Research section as the page renders it. */
async function marketMarkup(stock: string, kalshi: string, view?: ResearchView): Promise<string> {
  const { kalshiData, stockData, researchHistory, benchmarkData, longHistory } = loadAnalysis(stock, kalshi);
  const element = await Research({ kalshiData, stockData, historyData: researchHistory, longData: longHistory, benchmarkData, stock, kalshi, view });
  const html = renderToStaticMarkup(element);
  // The longer windows' history streams in after the first render; let it finish inside the test.
  await longHistory;
  return html;
}

/** An event's Research section as the page renders it. */
async function eventMarkup(stock: string, kalshi: string, view?: ResearchView): Promise<string> {
  const { event, stockData, benchmarkData, long } = loadEventAnalysis(stock, kalshi);
  const element = await EventResearch({ eventData: event, stockData, benchmarkData, longData: long, stock, kalshi, view });
  const html = renderToStaticMarkup(element);
  await long;
  return html;
}

describe("the Research panel's markup is unchanged", () => {
  it("for a live market, without the store", async () => {
    stubWorld([LIVE_MARKET]);
    const html = await marketMarkup("NVDA", LIVE_MARKET.ticker);
    expect(html).toContain("Same-hour correlation");
    expect(sha(pinnedMarkup(html))).toBe("4fb1ec2127180f30");
    expect(sha(pinnedMarkup(await marketMarkup("NVDA", LIVE_MARKET.ticker, LINKED)))).toBe("671d7a62f1a649b5");
  });

  it("for a market settled before the archive cutoff, from the store, ending at its close", async () => {
    stubWorld([SETTLED_MARKET]);
    await store([SETTLED_MARKET]);
    const html = await withStore(() => marketMarkup("TLT", SETTLED_MARKET.ticker));
    expect(html).toContain("in windows ending at the market&#x27;s close");
    expect(sha(pinnedMarkup(html))).toBe("3c68d5ad63cc90a7");
  });

  it("for a live event, without the store", async () => {
    stubWorld(LIVE_EVENT);
    const html = await eventMarkup("TLT", "KXFEDDECISION-26DEC");
    expect(html).toContain("ΔE");
    expect(sha(pinnedMarkup(html))).toBe("0f5b2f50936244ea");
    expect(sha(pinnedMarkup(await eventMarkup("TLT", "KXFEDDECISION-26DEC", LINKED)))).toBe("e4b9bd8a5cc41e60");
  });
});

/** The world's upstreams, with the scan's two routes answered by their loaders (as in scanRunner.test.ts). */
function stubScanRoutes() {
  stubWorld([SCAN_MARKET, ...SCAN_EVENT]);
  const world = globalThis.fetch;
  vi.stubGlobal("fetch", async (input: string | URL) => {
    const url = new URL(String(input), "http://localhost");
    if (url.pathname === SCAN_PRICES_PATH) {
      const span = parseSpan(url.searchParams, Date.now());
      if (!span.ok) return Response.json({ error: { code: "invalid_span", message: span.message } }, { status: 400 });
      const prices = await getScanPrices(url.searchParams.get("stock")!, span.value);
      return prices.ok ? Response.json(prices.data) : Response.json({ error: prices.error }, { status: 503 });
    }
    if (url.pathname === SCAN_CANDIDATE_PATH) {
      const r = await loadCandidateKalshi(url.searchParams.get("ticker")!, url.searchParams.get("kind") as "event" | "market", url.searchParams.get("long") === "1");
      return r.ok ? Response.json(r.data) : Response.json({ error: r.error }, { status: r.error.code === "not_found" ? 404 : 422 });
    }
    return world(input);
  });
}

function finished(run: ScanRunClass): Promise<ScanSnapshot> {
  return new Promise((resolve) => {
    const check = () => {
      const s = run.getSnapshot();
      if (s.phase === "done" || s.phase === "failed") resolve(s);
    };
    run.subscribe(check);
    check();
  });
}

/** The timings line measures this run's speed, so it's left out of the pin. */
const withoutTimings = (html: string) => html.replace(/<p class="mt-3 text-xs text-ink-muted">Prices in [\s\S]*?<\/p>/, "");

describe("the scan's results markup is unchanged", () => {
  it("for a market and an event, at 90 days hourly", async () => {
    stubScanRoutes();
    const list = await tickerCandidates([SCAN_MARKET.ticker, "KXFEDDECISION-26DEC"]);
    if (!list.ok) throw new Error("expected candidates");
    const settings = { stock: "TLT", choice: 90 as const, resolution: "hourly" as const, candidates: list.data.candidates };
    const run = new ScanRun(settings);
    expect((await finished(run)).phase).toBe("done");
    const html = renderToStaticMarkup(<ScanResults run={run} {...settings} />);
    expect(html).toContain("Exploratory leads, not findings.");
    expect(html).toMatch(/Prices in /);
    expect(sha(pinnedMarkup(withoutTimings(html)))).toBe("676ca7961e1a7870");
    run.dispose();
  });
});
