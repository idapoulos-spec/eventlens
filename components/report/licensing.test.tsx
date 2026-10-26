// Reports carry no stock prices. Twelve Data's free plan doesn't allow showing its data outside
// the app, and a report attached to an application is outside it, so a report may show
// statistics (correlations, betas, p-values, counts) and Kalshi data, but no price, price series,
// or price chart. Each report kind is built from a fake world whose stock (CNRY) and benchmark
// (CNRYB) trade near 98,765 and 87,654, prices no statistic would print, then searched for every
// bar's price in every form a page might print it. A scan's benchmark is SPY, whose prices are
// checked among the report's two-decimal numbers. A positive control proves the search finds one.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CANARY_START, stubWorld, worldEvent, worldMarket } from "@/lib/history/test-world";
import { renderHtml } from "@/lib/report/html";
import { renderMarkdown } from "@/lib/report/markdown";
import type { Report } from "@/lib/report/model";
import { parseSpan } from "@/lib/scan/api";
import { SCAN_CANDIDATE_PATH, SCAN_PRICES_PATH } from "@/lib/scan/types";
import type { ScanRun as ScanRunClass, ScanSnapshot } from "../scan/scanRunner";
import { MIN_TEST_EVENTS } from "@/lib/analytics";
import { eventPage, marketPage, reportFor, type PageDeps } from "./test-build";
import { numbersIn } from "./test-helpers";

vi.setConfig({ testTimeout: 120_000 });
vi.mock("server-only", () => ({}));
vi.mock("@/lib/store/db", () => ({ getAppSql: () => null }));

const NOW = Date.UTC(2026, 9, 7, 16, 40, 30);
const LIVE_MARKET = worldMarket("KXFEDDECISION-26DEC-H0", { status: "active", open: Date.UTC(2025, 4, 1), close: Date.UTC(2026, 11, 9, 19), archived: false });
const LONG_EVENT = worldEvent("KXFEDDECISION-26DEC", { status: "active", open: Date.UTC(2025, 5, 2, 14), close: Date.UTC(2026, 11, 9, 19), archived: false }, { bounded: true });
const SCAN_MARKET = worldMarket("KXFEDDECISION-26OCT-H0", { status: "active", open: Date.UTC(2025, 4, 1), close: Date.UTC(2026, 9, 28, 18), archived: false });
const LINK = "http://localhost/?stock=CNRY&kalshi=KXFEDDECISION-26DEC-H0&bench=CNRYB";

let deps: PageDeps;

beforeEach(async () => {
  vi.stubEnv("TWELVE_DATA_API_KEY", "test-key");
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  vi.resetModules();
  deps = {
    loadAnalysis: (await import("@/lib/history/analysis")).loadAnalysis,
    loadEventAnalysis: (await import("@/lib/expected/load")).loadEventAnalysis,
    Research: (await import("../Research")).Research,
    EventResearch: (await import("../event/EventDashboard")).EventResearch,
  };
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

/** Every price the fake world serves for a symbol: each 30-minute and daily bar's open, high, low, and close. */
async function pricesOf(symbol: string): Promise<number[]> {
  const out = new Set<number>();
  for (const interval of ["30min", "1day"]) {
    const res = await fetch(`https://api.twelvedata.com/time_series?${new URLSearchParams({ symbol, interval, outputsize: "100000", apikey: "test-key" })}`);
    const body = (await res.json()) as { values: Record<string, string>[] };
    for (const v of body.values) for (const k of ["open", "high", "low", "close"]) out.add(Number(v[k]));
  }
  return [...out];
}

/** Every way a page might print a price: 0–2 decimals, with or without thousands separators, with a dollar sign. */
function forms(price: number): string[] {
  const plain = [0, 1, 2].map((d) => price.toFixed(d));
  const grouped = [0, 1, 2].map((d) => price.toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d }));
  return [...new Set([...plain, ...grouped, ...grouped.map((g) => `$${g}`)])];
}

/** The prices found in `text`, in any form. */
function leaked(text: string, prices: number[]): string[] {
  return prices.flatMap((p) => forms(p).filter((f) => text.includes(f)));
}

const outputs = (report: Report) => [renderMarkdown(report), renderHtml(report)];

function expectNoPrices(report: Report, canaries: number[], spy: number[] = []) {
  for (const text of outputs(report)) {
    expect(leaked(text, canaries)).toEqual([]);
    expect(text).not.toMatch(/\$\s?\d/);
    // SPY's prices (near 100 in the fake world) can't be told from every number by their digits,
    // so none of the report's two-decimal numbers may be one of them.
    const spyCloses = new Set(spy.map((p) => p.toFixed(2)));
    expect(numbersIn(text).filter((n) => /^\d+\.\d\d$/.test(n) && spyCloses.has(n))).toEqual([]);
  }
}

describe("reports carry no stock prices", () => {
  it("in a single market's report, with a canary benchmark, at several settings", async () => {
    stubWorld([LIVE_MARKET]);
    const canaries = [...(await pricesOf("CNRY")), ...(await pricesOf("CNRYB"))];
    expect(Math.min(...canaries)).toBeGreaterThan(10_000);
    const page = await marketPage(deps, "CNRY", LIVE_MARKET.ticker, { window: null, resolution: null, benchmark: "CNRYB" });
    for (const view of [
      { choice: 90 as const, resolution: "hourly" as const },
      { choice: 90 as const, resolution: "hourly" as const, jump: 1 },
      { choice: 30 as const, resolution: "daily" as const, returns: "raw" as const },
      { choice: 7 as const, resolution: "hourly" as const },
    ]) {
      expectNoPrices(reportFor(page, "CNRY", LIVE_MARKET.ticker, { ...view, benchmark: "CNRYB" }, { link: LINK, preparedBy: "A. Reviewer" }), canaries);
    }
  });

  it("in a whole event's report", async () => {
    stubWorld(LONG_EVENT);
    const canaries = [...(await pricesOf("CNRY")), ...(await pricesOf("CNRYB"))];
    const page = await eventPage(deps, "CNRY", "KXFEDDECISION-26DEC", { window: null, resolution: null });
    expectNoPrices(reportFor(page, "CNRY", "KXFEDDECISION-26DEC", { choice: 90, resolution: "hourly" }, { link: LINK }), canaries, await pricesOf("SPY"));
  });

  it("in a scan's report", async () => {
    const { ScanRun } = await import("../scan/scanRunner");
    const { scanReport } = await import("./scanReport");
    const { getScanPrices } = await import("@/lib/scan/prices");
    const { loadCandidateKalshi } = await import("@/lib/scan/load");
    const { tickerCandidates } = await import("@/lib/scan/candidates");
    stubWorld([SCAN_MARKET, ...LONG_EVENT]);
    const canaries = await pricesOf("CNRY");
    const spy = await pricesOf("SPY");
    const world = globalThis.fetch;
    vi.stubGlobal("fetch", async (input: string | URL) => {
      const url = new URL(String(input), "http://localhost");
      if (url.pathname === SCAN_PRICES_PATH) {
        const span = parseSpan(url.searchParams, Date.now());
        const prices = span.ok ? await getScanPrices(url.searchParams.get("stock")!, span.value) : null;
        return prices?.ok ? Response.json(prices.data) : Response.json({ error: { code: "x", message: "x" } }, { status: 400 });
      }
      if (url.pathname === SCAN_CANDIDATE_PATH) {
        const r = await loadCandidateKalshi(url.searchParams.get("ticker")!, url.searchParams.get("kind") as "event" | "market", false);
        return r.ok ? Response.json(r.data) : Response.json({ error: r.error }, { status: 422 });
      }
      return world(input);
    });
    const list = await tickerCandidates([SCAN_MARKET.ticker, "KXFEDDECISION-26DEC"]);
    if (!list.ok) throw new Error("expected candidates");
    const run: ScanRunClass = new ScanRun({ stock: "CNRY", choice: 90, resolution: "hourly", candidates: list.data.candidates });
    const snap = await new Promise<ScanSnapshot>((resolve) => {
      const check = () => (run.getSnapshot().phase === "done" ? resolve(run.getSnapshot()) : undefined);
      run.subscribe(check);
      check();
    });
    run.dispose();
    expect(snap.states.filter((s) => s.status === "done")).toHaveLength(2);
    const report = scanReport({ stock: "CNRY", choice: 90, resolution: "hourly", candidates: list.data.candidates, snap, asOf: null, selection: "a custom list", link: LINK, preparedBy: null, generatedAt: NOW, version: "test", commit: "test" });
    expectNoPrices(report, canaries, spy);
  });

  it("would find a price if one slipped in (the positive control)", async () => {
    stubWorld([LIVE_MARKET]);
    const canaries = await pricesOf("CNRY");
    const page = await marketPage(deps, "CNRY", LIVE_MARKET.ticker, { window: null, resolution: null, benchmark: "CNRYB" });
    const report = reportFor(page, "CNRY", LIVE_MARKET.ticker, { choice: 90, resolution: "hourly", benchmark: "CNRYB" });
    const price = canaries[canaries.length - 1];
    for (const slipped of [price.toFixed(2), price.toLocaleString("en-US", { maximumFractionDigits: 2 }), `$${price.toLocaleString("en-US")}`]) {
      const text = renderMarkdown(report).replace("## Inputs", `## Inputs\n\nLast close ${slipped}`);
      expect(leaked(text, canaries).length, slipped).toBeGreaterThan(0);
    }
    expect(CANARY_START.CNRY).toBe(98765.4321);
  });
});

describe("reports carry no stock return finer than a statistic", () => {
  it("leave out each influential hour's return, and the event study's averages for groups under 5 events", async () => {
    stubWorld([LIVE_MARKET]);
    const page = await marketPage(deps, "CNRY", LIVE_MARKET.ticker, { window: null, resolution: null, benchmark: "CNRYB" });
    for (const jump of [2, 1]) {
      const report = reportFor(page, "CNRY", LIVE_MARKET.ticker, { choice: 90, resolution: "hourly", benchmark: "CNRYB", jump });
      const blocks = report.sections.flatMap((s) => s.blocks);
      const table = (id: string) => blocks.find((b) => b.kind === "table" && b.id === id) as Extract<Report["sections"][number]["blocks"][number], { kind: "table" }> | undefined;
      const hours = table("fragility-hours")!;
      expect(hours.head.some((h) => /return/i.test(h))).toBe(false);

      const { rises, falls } = countEvents(report);
      const events = table("event-study");
      const comparison = table("market-comparison")!;
      const chart = blocks.find((b) => b.kind === "chart" && b.id === "event-study");
      for (const [name, n, col] of [["Rises", rises, 3], ["Falls", falls, 4]] as const) {
        const shown = events?.head.some((h) => h.startsWith(name)) ?? false;
        expect(shown, `${name} at ${jump} pp (n = ${n})`).toBe(n >= MIN_TEST_EVENTS);
        expect(comparison.rows.every((r) => r[col].startsWith("n <")), `${name} averages at ${jump} pp`).toBe(n < MIN_TEST_EVENTS);
        // The chart draws a path only for a group with enough events.
        expect(chart?.kind === "chart" && chart.svg.includes(`After ${name.toLowerCase()} (`), `${name} path at ${jump} pp`).toBe(n >= MIN_TEST_EVENTS);
      }
      // Charts appear only for the lead-lag correlations, the rolling correlation, and the event study.
      expect(blocks.filter((b) => b.kind === "chart").map((b) => (b as { id: string }).id).every((id) => ["lead-lag", "rolling", "event-study"].includes(id))).toBe(true);
    }
  });
});

/** How many rises and falls the report's event study is based on (from its "Based on …" sentence). */
function countEvents(report: Report): { rises: number; falls: number } {
  const text = report.sections.find((s) => s.id === "event-study")!.blocks.map((b) => (b.kind === "paragraph" ? b.text : "")).join(" ");
  const m = /Based on (\d+) rises? and (\d+) falls?/.exec(text);
  if (!m) throw new Error(`no event counts in: ${text}`);
  return { rises: Number(m[1]), falls: Number(m[2]) };
}
