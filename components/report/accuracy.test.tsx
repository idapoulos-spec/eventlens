// A report's numbers are the page's. The page is rendered as the server renders it, from the fake
// world through the real loaders and components, with its background parts (the detectable size
// and the leave-one-out check) run at once; the report is built from the same rows and settings as
// the panel builds its results. Then every table the report shares with the page must match cell
// for cell (less the columns and cells reports leave out), the primary result must read the same,
// and every number in the report's results must be on the page.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PanelMessage } from "@/lib/analytics/panel-jobs";
import { stubWorld, worldEvent, worldMarket } from "@/lib/history/test-world";
import { sectionText, type Report } from "@/lib/report/model";
import { resultLine } from "./analysisReport";
import { eventPage, marketPage, reportFor, type PageDeps } from "./test-build";
import { numbersNotOn, tablesOf, textOf, type PageTable } from "./test-helpers";

vi.setConfig({ testTimeout: 120_000 });
vi.mock("server-only", () => ({}));
vi.mock("@/lib/store/db", () => ({ getAppSql: () => null }));
// The panel's background parts, run at once, so the server's render shows them.
vi.mock("@/components/research/panelJobs", async () => {
  const jobs = await import("@/lib/analytics/panel-jobs");
  const partId = (kind: string, key: string) => `${kind}:${key}`;
  return {
    partId,
    useDelayed: () => false,
    usePanelJobs: (list: Parameters<typeof jobs.runJob>[1][]) => {
      const parts = new Map<string, PanelMessage>();
      const run = jobs.panelRunner();
      for (const job of list) jobs.runJob(run, job, (m) => parts.set(partId(m.kind, m.key), m));
      return parts;
    },
  };
});

const NOW = Date.UTC(2026, 9, 7, 16, 40, 30);
const LIVE_MARKET = worldMarket("KXFEDDECISION-26DEC-H0", { status: "active", open: Date.UTC(2025, 4, 1), close: Date.UTC(2026, 11, 9, 19), archived: false });
const LONG_EVENT = worldEvent("KXFEDDECISION-26DEC", { status: "active", open: Date.UTC(2025, 5, 2, 14), close: Date.UTC(2026, 11, 9, 19), archived: false }, { bounded: true });

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

const tableOf = (report: Report, id: string) => {
  for (const s of report.sections) for (const b of s.blocks) if (b.kind === "table" && b.id === id) return b;
  return null;
};

/** The page's table whose header starts with `first` and holds `has`. */
function pageTable(tables: PageTable[], first: string, has?: string): PageTable | undefined {
  return tables.find((t) => t.head[0] === first && (has === undefined || t.head.includes(has)));
}

/** Every shared table, cell for cell; the primary result word for word; every result number on the page. Returns how many tables were compared. */
function expectReportMatchesPage(report: Report, html: string): number {
  const page = textOf(html);
  const tables = tablesOf(html);
  let compared = 0;

  const leadLag = tableOf(report, "lead-lag");
  if (leadLag) {
    expect(pageTable(tables, "Lag")?.rows, "lead-lag").toEqual(leadLag.rows);
    compared++;
  }
  const sessions = tableOf(report, "fragility-sessions");
  if (sessions) {
    expect(pageTable(tables, "#", "Share of score")?.rows, "fragility sessions").toEqual(sessions.rows);
    compared++;
  }
  const hours = tableOf(report, "fragility-hours");
  if (hours) {
    const t = tables.find((x) => x.head.includes("Abnormal return"))!;
    const dropped = t.head.indexOf("Abnormal return");
    expect(t.head.filter((_, k) => k !== dropped)).toEqual(hours.head);
    expect(t.rows.map((r) => r.filter((_, k) => k !== dropped)), "fragility hours").toEqual(hours.rows);
    compared++;
  }
  const events = tableOf(report, "event-study");
  if (events) {
    const t = pageTable(tables, "Bar")!;
    const keep = events.head.map((h) => t.head.indexOf(h));
    expect(keep.every((k) => k >= 0)).toBe(true);
    expect(t.rows.map((r) => keep.map((k) => r[k])), "event study").toEqual(events.rows);
    compared++;
  }
  const comparison = tableOf(report, "market-comparison");
  if (comparison) {
    const t = pageTable(tables, "Returns")!;
    expect(t.head).toEqual(comparison.head);
    comparison.rows.forEach((row, r) => row.forEach((c, k) => !c.startsWith("n <") && expect(t.rows[r][k], `market comparison ${r},${k}`).toBe(c)));
    compared++;
  }

  // The primary result reads exactly as on the page.
  const primary = report.sections.find((s) => s.id === "primary")!;
  const line = primary.blocks[0];
  if (line.kind === "paragraph" && line.text.startsWith("r = ")) expect(page).toContain(line.text);

  // Every number in the report's results, outside the tables just compared, is on the page.
  for (const s of report.sections.filter((x) => x.title.startsWith("Results"))) {
    const text = sectionText({ ...s, blocks: s.blocks.filter((b) => b.kind !== "table") });
    expect(numbersNotOn(text, page), s.id).toEqual([]);
  }
  return compared;
}

describe("an analysis report's numbers are its page's", () => {
  it("for a single market, at 90 days hourly, market-adjusted (the default)", async () => {
    stubWorld([LIVE_MARKET]);
    const page = await marketPage(deps, "NVDA", LIVE_MARKET.ticker, { window: null, resolution: null });
    const report = reportFor(page, "NVDA", LIVE_MARKET.ticker, { choice: 90, resolution: "hourly" });
    // The background parts are on both: the leave-one-out check finished, with its sessions' results.
    expect(sectionText(report.sections.find((s) => s.id === "fragility")!)).toContain("Without all");
    expect(textOf(page.html)).toContain("Without all");
    expect(expectReportMatchesPage(report, page.html)).toBeGreaterThanOrEqual(4);
  });

  it("for a single market with enough jumps for the event study's averages (1 pp)", async () => {
    stubWorld([LIVE_MARKET]);
    const page = await marketPage(deps, "NVDA", LIVE_MARKET.ticker, { window: null, resolution: null, jump: 1 });
    const report = reportFor(page, "NVDA", LIVE_MARKET.ticker, { choice: 90, resolution: "hourly", jump: 1 });
    expect(tableOf(report, "event-study")).not.toBeNull();
    expect(expectReportMatchesPage(report, page.html)).toBe(5);
  });

  it("would catch a report number that differs from the page's", async () => {
    stubWorld([LIVE_MARKET]);
    const page = await marketPage(deps, "NVDA", LIVE_MARKET.ticker, { window: null, resolution: null });
    const report = reportFor(page, "NVDA", LIVE_MARKET.ticker, { choice: 90, resolution: "hourly" });
    const cell = structuredClone(report);
    const leadLag = tableOf(cell, "lead-lag")!;
    leadLag.rows[0][1] = leadLag.rows[0][1] === "+0.99" ? "+0.98" : "+0.99";
    expect(() => expectReportMatchesPage(cell, page.html)).toThrow();
    const sentence = structuredClone(report);
    const summary = sentence.sections.find((s) => s.id === "summary")!.blocks[0];
    if (summary.kind !== "paragraph") throw new Error("expected the summary line");
    summary.text = summary.text.replace(/\d[\d,]* hourly intervals/, "123,456 hourly intervals");
    expect(() => expectReportMatchesPage(sentence, page.html)).toThrow();
  });

  it("for a single market at 30 days daily, raw returns, and another jump size", async () => {
    stubWorld([LIVE_MARKET]);
    const view = { window: 30, resolution: "daily", returns: "raw", jump: 5 } as const;
    const page = await marketPage(deps, "NVDA", LIVE_MARKET.ticker, view);
    expect(expectReportMatchesPage(reportFor(page, "NVDA", LIVE_MARKET.ticker, { choice: 30, resolution: "daily", returns: "raw", jump: 5 }), page.html)).toBeGreaterThanOrEqual(2);
  });

  it("for a single market whose benchmark is the stock itself (no primary test)", async () => {
    stubWorld([LIVE_MARKET]);
    const page = await marketPage(deps, "NVDA", LIVE_MARKET.ticker, { window: 7, resolution: null, benchmark: "NVDA" });
    const report = reportFor(page, "NVDA", LIVE_MARKET.ticker, { choice: 7, resolution: "hourly", benchmark: "NVDA" });
    expect(sectionText(report.sections.find((s) => s.id === "primary")!)).toContain("No primary test");
    expect(expectReportMatchesPage(report, page.html)).toBeGreaterThanOrEqual(1);
  });

  it("for a whole event's expected value, at 90 days hourly", async () => {
    stubWorld(LONG_EVENT);
    const page = await eventPage(deps, "TLT", "KXFEDDECISION-26DEC", { window: null, resolution: null });
    expect(expectReportMatchesPage(reportFor(page, "TLT", "KXFEDDECISION-26DEC", { choice: 90, resolution: "hourly" }), page.html)).toBeGreaterThanOrEqual(4);
  });

  it("lists every setting under Inputs whether or not the link is included", async () => {
    stubWorld([LIVE_MARKET]);
    const page = await marketPage(deps, "NVDA", LIVE_MARKET.ticker, { window: 30, resolution: "daily", returns: "raw", jump: 5 });
    const view = { choice: 30, resolution: "daily", returns: "raw", jump: 5 } as const;
    const withLink = reportFor(page, "NVDA", LIVE_MARKET.ticker, view, { link: "http://localhost/?stock=NVDA", generatedAt: NOW });
    const without = reportFor(page, "NVDA", LIVE_MARKET.ticker, view, { link: null, generatedAt: NOW });
    const inputs = (r: Report) => JSON.stringify(r.sections.find((s) => s.id === "inputs"));
    expect(inputs(without)).toBe(inputs(withLink));
    expect(sectionText(without.sections.find((s) => s.id === "inputs")!)).toMatch(/Window: 30D[\s\S]*Resolution: Daily[\s\S]*Returns shown: Raw[\s\S]*Benchmark: SPY[\s\S]*Jump size \(event study\): ≥ 5 pp/);
    expect(JSON.stringify({ ...without, footer: null })).toBe(JSON.stringify({ ...withLink, footer: null }));
  });

  it("reads the primary result as the page's ResultLine does", () => {
    const test = { estimate: 0.1234, ci: [-0.03, 0.26] as [number, number], p: 0.11, holm: null, bh: null, n: 118, nEffective: 96.2, role: "primary" as const, method: "wild_bootstrap" as const, resampling: null, pUnavailable: null };
    expect(resultLine(test as never)).toBe("r = +0.12 (95% CI −0.03 to +0.26), p = 0.110, n = 118 (≈ 96 eff.): not distinguishable from zero at the 5% level.");
  });
});
