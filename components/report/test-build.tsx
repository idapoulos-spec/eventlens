// Loading an analysis page from the fake world and building its report as the panel would: shared
// by the report tests. The loaders and components are passed in, since each test imports them
// fresh (vi.resetModules) for a clean server memory.

import { renderToStaticMarkup } from "react-dom/server";
import type { KalshiVariable, Resolution } from "@/lib/analytics";
import { expectedVariable, probabilityVariable } from "@/lib/analytics/variable";
import { panelCore, panelEvents, panelResults, type PanelInput, type Returns } from "@/lib/analytics/panel";
import { panelRunner, runJob } from "@/lib/analytics/panel-jobs";
import type { DetectableCorrelation } from "@/lib/analytics/correlation-test";
import type { LeaveOneOut } from "@/lib/analytics/fragility";
import { eventResearchRows, lastRows, marketResearchRows, type ResearchRows } from "@/lib/history/rows";
import { STOCK_HISTORY_MS, type ResearchView, type WindowChoice } from "@/lib/history/window";
import { benchmarkFrom } from "@/lib/market-data/benchmark-series";
import type { BenchmarkSeries } from "@/lib/market-data/types";
import type { Report } from "@/lib/report/model";
import type { loadAnalysis as LoadAnalysis } from "@/lib/history/analysis";
import type { loadEventAnalysis as LoadEventAnalysis } from "@/lib/expected/load";
import type { Research as ResearchComponent } from "../Research";
import type { EventResearch as EventResearchComponent } from "../event/EventDashboard";
import { analysisReport, type AnalysisReportInput, type ReportSources } from "./analysisReport";

const DAY_MS = 24 * 60 * 60 * 1000;

export interface PageDeps {
  loadAnalysis: typeof LoadAnalysis;
  loadEventAnalysis: typeof LoadEventAnalysis;
  Research: typeof ResearchComponent;
  EventResearch: typeof EventResearchComponent;
}

/** What the page loaded, as the panel gets it. */
export interface Loaded {
  html: string;
  rows: ResearchRows;
  benchmark: BenchmarkSeries | null;
  variable: KalshiVariable;
  sources: ReportSources;
}

export async function marketPage({ loadAnalysis, Research }: PageDeps, stock: string, kalshi: string, view: ResearchView): Promise<Loaded> {
  const { kalshiData, stockData, researchHistory, benchmarkData, longHistory } = loadAnalysis(stock, kalshi, view.benchmark ? { benchmark: view.benchmark } : {});
  const html = renderToStaticMarkup(await Research({ kalshiData, stockData, historyData: researchHistory, longData: longHistory, benchmarkData, stock, kalshi, view }));
  const [k, s, h, b] = await Promise.all([kalshiData, stockData, researchHistory, benchmarkData]);
  await longHistory;
  if (!k.ok || !s.ok || !h.ok) throw new Error("expected an analysis");
  const rows = marketResearchRows({ kalshi: h.data.points, closeTime: Date.parse(k.data.market.closeTime!), research: s.data.research, fetchedAt: s.data.historyFetchedAt });
  const asOf = lastRows(rows).asOf;
  return {
    html,
    rows,
    benchmark: b?.ok ? benchmarkFrom(b.data, Math.min(s.data.research.longStart, asOf - STOCK_HISTORY_MS)) : null,
    variable: probabilityVariable(k.data.market.subtitle ?? k.data.market.title),
    sources: { kalshiFetchedAt: k.data.fetchedAt, stockFetchedAt: s.data.historyFetchedAt, provenance: h.data.provenance, title: k.data.market.title },
  };
}

export async function eventPage({ loadEventAnalysis, EventResearch }: PageDeps, stock: string, kalshi: string, view: ResearchView): Promise<Loaded> {
  const { event, stockData, benchmarkData, long } = loadEventAnalysis(stock, kalshi);
  const html = renderToStaticMarkup(await EventResearch({ eventData: event, stockData, benchmarkData, longData: long, stock, kalshi, view }));
  const [e, s, b] = await Promise.all([event, stockData, benchmarkData]);
  await long;
  if (!e.ok || !s.ok) throw new Error("expected an analysis");
  const rows = eventResearchRows({ marks: e.data.marks, research: s.data.research, fetchedAt: s.data.historyFetchedAt });
  const asOf = lastRows(rows).asOf;
  return {
    html,
    rows,
    benchmark: b?.ok ? benchmarkFrom(b.data, Math.min(s.data.research.longStart, asOf - STOCK_HISTORY_MS)) : null,
    variable: expectedVariable(e.data),
    sources: { kalshiFetchedAt: e.data.fetchedAt, stockFetchedAt: s.data.historyFetchedAt, provenance: e.data.provenance, title: e.data.title },
  };
}

type LoadedView = { choice: 7 | 30 | 90; resolution: Resolution; returns?: Returns; jump?: number; benchmark?: string };
type ReportOptions = { link?: string | null; preparedBy?: string | null; generatedAt?: number };

/** The report for a view of a loaded window (7, 30, or 90 days), from the panel's own computations. */
export function reportFor(page: Loaded, stock: string, kalshi: string, view: LoadedView, options: ReportOptions = {}): Report {
  return analysisReport(reportInputFor(page, stock, kalshi, view, options));
}

/** What the panel holds for that view, as a report (and the plain-English summary) reads it. */
export function reportInputFor(
  page: Loaded,
  stock: string,
  kalshi: string,
  view: LoadedView,
  { link = null, preparedBy = null, generatedAt = Date.now() }: ReportOptions = {},
): AnalysisReportInput {
  const { hourly, daily, asOf } = lastRows(page.rows);
  const resolution: Resolution = view.choice === 7 ? "hourly" : view.resolution;
  const benchmark = view.benchmark ?? "SPY";
  const isSelf = benchmark === stock;
  const closes = isSelf || !page.benchmark ? null : resolution === "hourly" ? page.benchmark.hourly : page.benchmark.daily;
  const threshold = view.jump ?? page.variable.defaultThreshold[resolution];
  const chosenReturns = view.returns ?? "adjusted";
  const input: PanelInput = { full: resolution === "hourly" ? hourly : daily, from: asOf - view.choice * DAY_MS, resolution, scale: page.variable.scale, closes, returns: chosenReturns };
  const core = panelCore(input);
  const results = panelResults(core, panelEvents(input, core, threshold));
  let detectable: DetectableCorrelation | null = null;
  let leaveOneOut: LeaveOneOut | null = null;
  if (core.market?.primary?.p != null) {
    runJob(panelRunner(), { kind: "secondary", key: "s", coreKey: "s|light", input }, (m) => {
      if (m.kind === "detectable") detectable = m.value;
      if (m.kind === "leave_one_out") leaveOneOut = m.value;
    });
  }
  return {
    stock,
    kalshi,
    variable: page.variable,
    choice: view.choice as WindowChoice,
    resolution,
    threshold,
    chosenReturns,
    benchmark,
    benchmarkFetchedAt: page.benchmark?.fetchedAt ?? null,
    isSelf,
    unavailable: isSelf ? `${stock} is the benchmark itself` : "Too few prices to estimate beta",
    asOf,
    windowEnd: null,
    windowFrozen: false,
    frozenAt: null,
    windowNote: null,
    results,
    detectable,
    leaveOneOut,
    sample: { kind: "loaded", days: view.choice },
    fewRuns: resolution === "daily" && view.choice < 90,
    longDaily: false,
    sources: page.sources,
    link,
    preparedBy,
    generatedAt,
    version: "test",
    commit: "test",
  };
}

