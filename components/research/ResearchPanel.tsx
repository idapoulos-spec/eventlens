"use client";

import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  ALPHA,
  MIN_TEST_EVENTS,
  passes,
  researchCsv,
  SMALL_EVENT_COUNT,
  type ChangePoint,
  type ChangeSeries,
  type CorrelationStats,
  type DetectableCorrelation,
  type EventStudy,
  type EventStudyTests,
  type GroupTests,
  type KalshiVariable,
  type LagCorrelation,
  type MarketModel,
  type Resolution,
  type ResearchRow,
  type RollingPoint,
  type TestResult,
  rowsSince,
} from "@/lib/analytics";
import { DESCRIPTIVE_MIN_SESSIONS, FRAGILE, fragileReasons, type Fragility, type FragileReason, type LeaveOneOut } from "@/lib/analytics/fragility";
import {
  COMPUTE_SETTINGS,
  panelCore,
  panelEvents,
  panelResults,
  type ComputeSettings,
  type PanelInput,
  type PanelResults,
  type Returns,
} from "@/lib/analytics/panel";
import type { PanelJob, PanelMessage } from "@/lib/analytics/panel-jobs";
import type { LongRows } from "@/lib/history/rows";
import { fromNewYorkInput, newYorkInput, WINDOW_LABEL, WINDOWS, windowPlan, type ResearchView, type WindowChoice, type WindowPlan } from "@/lib/history/window";
import { DEFAULT_BENCHMARK } from "@/lib/market-data/benchmark-series";
import { formatDate, formatDateTime, formatShortDate, formatSigned, formatTime } from "@/lib/format";
import type { BenchmarkSeries } from "@/lib/market-data/types";
import { fail, type Result } from "@/lib/result";
import { analysisFromSearch, analysisHref } from "../analysis/navigation";
import { SaveStudy } from "../studies/SaveStudy";
import { analysisFileBase, analysisReport, type ReportSources } from "../report/analysisReport";
import { ReportControls } from "../report/ReportControls";
import { APP_COMMIT, APP_VERSION } from "@/lib/report/version";
import { EventStudyChart } from "../charts/EventStudyChart";
import { formatLag, LeadLagChart, type LagUnit } from "../charts/LeadLagChart";
import { RollingCorrelationChart } from "../charts/RollingCorrelationChart";
import { Card, Notice } from "../ui";
import { MarketAdjustmentCard, modelSample, type ModelSample } from "./MarketAdjustmentCard";
import { partId, useDelayed, usePanelJobs } from "./panelJobs";
import { Caption, Flag, fmtR, plural, Segmented, Table, ValuesTable } from "./parts";
import {
  eventFamilyText,
  formatCi,
  formatMinP,
  formatP,
  methodText,
  ResultLine,
  RoleBadge,
  TEST_COLUMNS,
  testCells,
  unavailableText,
  verdict,
} from "./stats";
import { useBenchmark, type BenchmarkChoice } from "./useBenchmark";

const DAY_MS = 24 * 60 * 60 * 1000;

export interface Settings extends ComputeSettings {
  unit: LagUnit;
  /** Singular and plural names of one interval. */
  noun: [string, string];
  /** e.g. "Same-hour correlation". */
  same: string;
  /** What an event-study bar spans. */
  barNote: string;
  rollingSpan: string;
}

export const SETTINGS: Record<Resolution, Settings> = {
  hourly: {
    ...COMPUTE_SETTINGS.hourly,
    unit: "h",
    noun: ["hour", "hours"],
    same: "Same-hour",
    barNote: "Bars are trading hours, so a window can span a night or weekend.",
    rollingSpan: "about 3 sessions",
  },
  daily: {
    ...COMPUTE_SETTINGS.daily,
    unit: "d",
    noun: ["trading day", "trading days"],
    same: "Same-day",
    barNote: "Bars are trading days.",
    rollingSpan: "about a month",
  },
};

// A rolling view needs this many intervals beyond one window to show any change over time.
export const ROLLING_EXTRA = 10;

const COMMON_EXCLUSIONS: Record<string, string> = {
  before_kalshi: "before Kalshi's first price in the loaded history",
  market_closed: "after the market closed",
  kalshi_last_price: "priced from a last trade (one-sided book)",
  expected_missing: "without an expected value at one end (see the event panel for why)",
  outcome_set_changed: "across a change in which outcomes were open",
};

export const EXCLUSION_LABEL: Record<Resolution, Record<string, string>> = {
  hourly: { non_trading: "across nights, weekends, or halts", ...COMMON_EXCLUSIONS },
  daily: { non_trading: "across a missing session", ...COMMON_EXCLUSIONS },
};

interface Props {
  hourly: ResearchRow[];
  daily: ResearchRow[];
  /** Windows count back from here: when the stock data was fetched, or the market's close (see windowEnd). */
  asOf: number;
  /** A closed market's close, when Research ends there rather than now; benchmarks are loaded for that window. */
  windowEnd: number | null;
  stockSymbol: string;
  kalshiTicker: string;
  /** What's studied on the Kalshi side, its unit, and its labels: a market's probability or an event's expected value. */
  variable: KalshiVariable;
  /** The default benchmark as the server loaded it, or null if it wasn't requested (the stock is the benchmark). */
  initialBenchmark: Result<BenchmarkSeries> | null;
  /**
   * Rows for the 180-day, 1-year, and All windows, streamed after the page's first render: null when
   * the market is no older than the 90 days above, so those windows are the 90-day one.
   */
  long: Promise<Result<LongRows | null>>;
  /** When the market (an event's first outcome) opened, ms, if known: no window reaches further back. */
  opened: number | null;
  /** Where the panel opens when the link says (every setting, and its as-of time); otherwise 90D, hourly, adjusted, SPY. */
  initialView?: ResearchView;
  /** Research ends at a frozen link's as-of time (windowEnd), rather than a close. */
  windowFrozen?: boolean;
  /**
   * The market's close, when it has passed but the windows still end now (without the data store):
   * a frozen link's windows end at the close instead, so its numbers can differ from these.
   */
  closedAt?: number | null;
  /** Where the data came from, for a report. */
  sources?: ReportSources;
}

/** How the market-adjusted view was adjusted, for its captions. */
export interface Adjustment {
  benchmark: string;
  model: MarketModel;
  eventModel: MarketModel | null;
  missingBenchmark: number;
  /** Where the market model comes from: the last 90 days (for windows up to 90 days, so maybe not only this window), or the window itself. */
  sample: ModelSample;
}

/** The longer rows once they've streamed in (null until then). A promise that fails reads as a failure, never a crash. */
function useLongRows(promise: Promise<Result<LongRows | null>>): Result<LongRows | null> | null {
  const [state, setState] = useState<{ promise: Promise<Result<LongRows | null>>; value: Result<LongRows | null> } | null>(null);
  useEffect(() => {
    let live = true;
    Promise.resolve(promise).then(
      (value) => live && setState({ promise, value }),
      () => live && setState({ promise, value: fail("unavailable", "The longer history couldn't be loaded.") }),
    );
    return () => {
      live = false;
    };
  }, [promise]);
  return state?.promise === promise ? state.value : null;
}

/** Times a computation in the browser's performance timeline (DevTools → Performance), as `research:<name>`. */
function timed<T>(name: string, compute: () => T): T {
  const start = typeof performance === "undefined" ? 0 : performance.now();
  const value = compute();
  try {
    performance.measure(`research:${name}`, { start, duration: performance.now() - start });
  } catch {
    // On the server, or an older browser: no timing marks.
  }
  return value;
}

export function ResearchPanel({
  hourly,
  daily,
  asOf,
  windowEnd,
  stockSymbol,
  kalshiTicker,
  variable,
  initialBenchmark,
  long: longRows,
  opened,
  initialView,
  windowFrozen = false,
  closedAt = null,
  sources = { kalshiFetchedAt: null, stockFetchedAt: null, provenance: null, title: null },
}: Props) {
  // 90 days by default: with 30 days of hourly data the power tests (correlation-test.test.ts)
  // miss a correlation of about 0.4 roughly half the time.
  const [choice, setChoice] = useState<WindowChoice>(initialView?.window ?? 90);
  const [chosenResolution, setResolution] = useState<Resolution>(initialView?.resolution ?? "hourly");
  const [thresholds, setThresholds] = useState<Record<Resolution, number>>(() => linkedThresholds(variable, initialView));
  // Market-adjusted by default, since the primary test always is; raw when adjustment isn't possible.
  const [chosenReturns, setReturns] = useState<Returns>(initialView?.returns === "raw" ? "raw" : "adjusted");
  const benchmark = useBenchmark(initialBenchmark, windowEnd, { first: linkedBenchmark(initialView), frozen: windowFrozen });
  // Where the link freezes the windows: its as-of time, or this view's once frozen; null while live.
  const [frozenAt, setFrozenAt] = useState<number | null>(initialView?.asOf ?? null);
  const long = useLongRows(longRows);
  // Seven days hold only about five daily closes, so that window is hourly only.
  const resolution: Resolution = choice === 7 ? "hourly" : chosenResolution;
  const settings = SETTINGS[resolution];
  const threshold = thresholds[resolution];
  const isSelf = benchmark.active.symbol === stockSymbol;
  const plan = useMemo(() => windowPlan(choice, long, asOf), [choice, long, asOf]);

  const benchSeries = isSelf ? null : benchmark.series;
  const closes = benchSeries && (resolution === "hourly" ? benchSeries.hourly : benchSeries.daily);
  // Up to 90 days, the market model is fitted on the 90 days loaded; beyond, on the window itself.
  const syncInput = useMemo<PanelInput | null>(
    () =>
      plan.kind === "loaded"
        ? { full: resolution === "hourly" ? hourly : daily, from: asOf - plan.days * DAY_MS, resolution, scale: variable.scale, closes, returns: chosenReturns }
        : null,
    [plan, hourly, daily, asOf, resolution, variable.scale, closes, chosenReturns],
  );
  const longInput = useMemo<PanelInput | null>(
    () =>
      plan.kind === "long"
        ? {
            full: rowsSince(resolution === "hourly" ? plan.rows.hourly : plan.rows.daily, plan.from),
            from: -Infinity,
            resolution,
            scale: variable.scale,
            closes,
            returns: chosenReturns,
          }
        : null,
    [plan, resolution, variable.scale, closes, chosenReturns],
  );

  // The windows the page loaded with are computed here, as they always were (the jump size recomputes
  // only the event study); the longer ones in the background (panelJobs.ts).
  const core = useMemo(() => syncInput && timed("core", () => panelCore(syncInput)), [syncInput]);
  const events = useMemo(() => syncInput && core && timed("events", () => panelEvents(syncInput, core, threshold)), [syncInput, core, threshold]);
  const syncResults = useMemo(() => core && events && panelResults(core, events), [core, events]);

  const benchKey = isSelf ? "self" : benchSeries ? benchSeries.symbol : "none";
  const windowKey = plan.kind === "long" ? `long:${choice}` : plan.kind === "loaded" ? `loaded:${plan.days}` : null;
  const secondaryKey = windowKey && `${windowKey}|${resolution}|${benchKey}`;
  const coreKey = secondaryKey && `${secondaryKey}|${chosenReturns}`;
  const mainKey = coreKey && `${coreKey}|${threshold}`;
  const jobs: PanelJob[] = [];
  if (longInput && coreKey && mainKey) jobs.push({ kind: "main", key: mainKey, coreKey, input: longInput, threshold });
  // The detectable size and the leave-one-out check, for any window whose primary test has a p-value.
  const secondaryInput = syncInput ?? longInput;
  const hasP = plan.kind === "long" || core?.market?.primary?.p != null;
  if (secondaryInput && secondaryKey && hasP) {
    jobs.push({ kind: "secondary", key: secondaryKey, coreKey: plan.kind === "long" ? coreKey! : `${secondaryKey}|light`, input: secondaryInput });
  }
  const parts = usePanelJobs(jobs);
  const part = <K extends PanelMessage["kind"]>(kind: K, key: string | null) =>
    key === null ? undefined : (parts.get(partId(kind, key)) as Extract<PanelMessage, { kind: K }> | undefined);

  const results: PanelResults | null = plan.kind === "loaded" ? syncResults : (part("main", mainKey)?.value ?? null);
  const market = results?.market ?? null;
  const primary = market?.primary ?? null;
  const significant = primary?.p != null && primary.p < ALPHA;
  const detectablePart = part("detectable", secondaryKey);
  const looPart = part("leave_one_out", secondaryKey);
  const secondaryPending = useDelayed(primary?.p != null && !looPart ? secondaryKey : null);
  const longPending = useDelayed(plan.kind === "long" && !results ? mainKey : plan.kind === "waiting" ? "waiting" : null, 0);

  const canAdjust = Boolean(market?.model && market.abnormal);
  const returns: Returns = results?.shown ?? "raw";
  const sample: ModelSample = plan.kind === "long" ? { kind: "window", label: WINDOW_LABEL[choice] } : { kind: "loaded", days: plan.kind === "loaded" ? plan.days : 90 };
  const adjustment: Adjustment | null =
    returns === "adjusted" && market?.model
      ? {
          benchmark: benchmark.active.symbol,
          model: market.model,
          eventModel: market.eventModel,
          missingBenchmark: market.missingBenchmark,
          sample,
        }
      : null;
  const unavailable = isSelf
    ? `${stockSymbol} is the benchmark itself`
    : benchmark.status.state === "loading" && !benchmark.series
      ? "Loading the benchmark"
      : !benchmark.series
        ? "Benchmark prices aren’t available"
        : "Too few prices to estimate beta";
  const note = windowNote(choice, plan, long, opened, asOf, variable.kind === "probability" ? "This market" : "This event’s first outcome");

  // Every setting in the URL (defaults left out), so the address and Copy link reproduce this view.
  const linkView: ResearchView = {
    window: choice === 90 ? null : choice,
    resolution: chosenResolution === "hourly" ? null : chosenResolution,
    returns: chosenReturns === "raw" ? "raw" : null,
    benchmark: benchmark.active.symbol === DEFAULT_BENCHMARK.symbol ? null : benchmark.active.symbol,
    jump: threshold === variable.defaultThreshold[resolution] ? null : threshold,
    asOf: frozenAt,
  };
  useLinkSync(linkView);

  function downloadCsv() {
    if (!results) return;
    const closesByT = closes && new Map(closes.map((p) => [p.t, p.value]));
    const csvBenchmark = closesByT && { symbol: benchmark.active.symbol, closesByT, model: market?.model ?? null };
    const blob = new Blob([researchCsv(results.rows, resolution, csvBenchmark, variable)], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `eventlens_${stockSymbol}_${kalshiTicker}_${choice === "all" ? "all" : `${choice}d`}_${resolution}_${new Date(asOf).toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  return (
    <div className="grid gap-4 sm:gap-5">
      <Card
        title="Research"
        subtitle={`${variable.kind === "probability" ? "Kalshi probability changes" : variable.text.changes} vs. ${stockSymbol} returns, compared only where both have a real observation${
          windowEnd === null
            ? ""
            : windowFrozen
              ? `, in windows ending at the link’s as-of time (${formatDateTime(windowEnd, { withYear: true })})`
              : `, in windows ending at the ${variable.kind === "probability" ? "market's" : "event's first"} close (${formatDateTime(windowEnd, { withYear: true })})`
        }`}
      >
        <div className="flex flex-col gap-3 sm:flex-row sm:flex-wrap sm:items-end">
          <Segmented
            label="Window"
            value={choice}
            options={WINDOWS.map((w) => ({ value: w, label: WINDOW_LABEL[w] }))}
            onChange={setChoice}
          />
          <Segmented
            label="Resolution"
            value={resolution}
            options={[
              { value: "hourly" as const, label: "Hourly" },
              { value: "daily" as const, label: "Daily", disabled: choice === 7, title: "Seven days hold only about five daily closes" },
            ]}
            onChange={setResolution}
          />
          <Segmented
            label="Returns"
            value={returns}
            options={[
              { value: "raw" as const, label: "Raw" },
              { value: "adjusted" as const, label: "Market-adjusted", disabled: !canAdjust, title: unavailable },
            ]}
            onChange={setReturns}
          />
          <label className="block">
            <span className="mb-1.5 block text-xs font-medium text-ink-secondary">Jump size (event study)</span>
            <select
              value={threshold}
              onChange={(e) => setThresholds((t) => ({ ...t, [resolution]: Number(e.target.value) }))}
              className="h-10 w-full rounded-lg border border-border bg-surface-raised px-3 text-base text-ink focus:border-series-kalshi focus:outline-none sm:h-8 sm:w-auto sm:text-xs"
            >
              {variable.thresholds.map((t) => (
                <option key={t} value={t}>
                  ≥ {t} {variable.unit} in one {settings.noun[0]}
                </option>
              ))}
            </select>
          </label>
          <button
            type="button"
            onClick={downloadCsv}
            disabled={!results}
            className="h-10 disabled:cursor-not-allowed disabled:opacity-40 rounded-lg border border-border px-3 text-sm text-ink-secondary transition hover:bg-surface-raised hover:text-ink sm:ml-auto sm:h-8 sm:text-xs"
          >
            Download CSV
          </button>
        </div>
        <section data-report-controls="" className="mt-3 border-t border-border pt-3 text-xs text-ink-secondary">
          <FreezeControls
            asOf={asOf}
            windowEnd={windowEnd}
            windowFrozen={windowFrozen}
            frozenAt={frozenAt}
            closedAt={closedAt}
            onFreeze={() => setFrozenAt(asOf)}
            onLive={() => (windowFrozen ? goTo({ ...linkView, asOf: null }) : setFrozenAt(null))}
            onLoad={(t) => goTo({ ...linkView, asOf: t })}
            subject={variable.kind === "probability" ? "market’s" : "event’s first"}
          />
          <div className="mt-2">
            <SaveStudy
              defaultName={`${stockSymbol} vs. ${kalshiTicker} · ${WINDOW_LABEL[choice]} ${resolution}`}
              link={(freeze) => {
                const analysis = analysisFromSearch(window.location.search);
                return analysis && analysisHref(analysis, { ...linkView, asOf: freeze ? asOf : frozenAt });
              }}
              freezeLabel={frozenAt === null ? `Freeze it at this view’s time (${formatDateTime(asOf, { withYear: true })}), so its link gives these numbers later` : null}
              headline={primaryHeadline(primary)}
              onFrozen={() => setFrozenAt(asOf)}
            />
          </div>
          <div className="mt-2">
            <ReportControls
              ready={results !== null && !(primary?.p != null && !looPart)}
              pendingText={results === null ? "The report waits for the results." : "The report waits for the leave-one-out check…"}
              fileBase={analysisFileBase({ stock: stockSymbol, kalshi: kalshiTicker, choice, resolution, asOf })}
              build={({ preparedBy, includeLink }) => {
                if (!results) return null;
                const analysis = analysisFromSearch(window.location.search);
                return analysisReport({
                  stock: stockSymbol,
                  kalshi: kalshiTicker,
                  variable,
                  choice,
                  resolution,
                  threshold,
                  chosenReturns,
                  benchmark: benchmark.active.symbol,
                  benchmarkFetchedAt: benchSeries?.fetchedAt ?? null,
                  isSelf,
                  unavailable,
                  asOf,
                  windowEnd,
                  windowFrozen,
                  frozenAt,
                  windowNote: note,
                  results,
                  detectable: detectablePart?.value ?? null,
                  leaveOneOut: looPart?.value ?? null,
                  sample,
                  fewRuns: resolution === "daily" && plan.kind === "loaded" && plan.days < 90,
                  longDaily: resolution === "daily" && plan.kind === "long",
                  sources,
                  link: includeLink && analysis ? new URL(analysisHref(analysis, linkView), window.location.origin).href : null,
                  preparedBy,
                  generatedAt: Date.now(),
                  version: APP_VERSION,
                  commit: APP_COMMIT,
                });
              }}
            />
          </div>
        </section>
        {note && (
          <p role="status" className="mt-2 text-xs text-ink-secondary">
            {note}
          </p>
        )}
        {results && chosenReturns === "adjusted" && returns === "raw" && (
          <p role="status" className="mt-2 text-xs text-ink-secondary">
            Showing raw returns: {lowerFirst(unavailable)}, so market-adjusted returns can’t be computed.
          </p>
        )}

        {!results ? (
          <div className="mt-4" aria-busy={plan.kind !== "failed"}>
            {plan.kind === "failed" ? (
              <Notice tone="error" title="Longer windows couldn’t be loaded" message={`${plan.message} The 7, 30, and 90-day windows still work.`} />
            ) : (
              longPending && (
                <Notice
                  tone="info"
                  title={plan.kind === "waiting" ? "Loading the longer history…" : `Computing the ${WINDOW_LABEL[choice]} window…`}
                  message={
                    plan.kind === "waiting"
                      ? "It streams in after the page; the 7, 30, and 90-day windows are ready now."
                      : "Longer windows are computed in the background so the page stays responsive; this usually takes under a second."
                  }
                />
              )
            )}
          </div>
        ) : (
          <>
            <Summary
              changes={results.view.changes}
              excluded={results.series.excluded}
              stats={results.view.sameInterval}
              resolution={resolution}
              settings={settings}
              adjustment={adjustment}
              rawR={results.rawSame.r}
              variable={variable}
            />

            <PrimaryTest
              primary={primary}
              detectable={detectablePart?.value ?? null}
              fragility={results.fragility}
              leaveOneOut={looPart?.value ?? null}
              pending={secondaryPending}
              significant={significant}
              fewRuns={resolution === "daily" && plan.kind === "loaded" && plan.days < 90}
              longDaily={resolution === "daily" && plan.kind === "long"}
              unavailable={unavailable}
              benchmark={benchmark.active.symbol}
              stockSymbol={stockSymbol}
              settings={settings}
              variable={variable}
              resolution={resolution}
            />
          </>
        )}

        <SignNote stockSymbol={stockSymbol} variable={variable} />
      </Card>

      {results && (
        <MarketAdjustmentCard
          stockSymbol={stockSymbol}
          benchmark={benchmark}
          isSelf={isSelf}
          market={market}
          raw={{ same: results.rawSame, study: results.rawStudy }}
          resolution={resolution}
          sample={sample}
          unit={settings.unit}
          same={settings.same}
          noun={settings.noun}
          variable={variable}
        />
      )}

      {results &&
        (results.view.changes.length === 0 ? (
          <Notice
            tone="info"
            title="Nothing to analyze in this window"
            message={`No intervals have a usable ${variable.kind === "probability" ? "Kalshi price" : "expected value"} and stock price at both ends. The CSV lists every row with the reason it was left out.`}
          />
        ) : (
          <>
            <div className="grid gap-4 sm:gap-5 lg:grid-cols-2">
              <LeadLagCard
                lags={results.view.lags}
                adjustedBy={returns === "adjusted" ? benchmark.active.symbol : null}
                settings={settings}
                stockSymbol={stockSymbol}
                variable={variable}
                adjustment={adjustment}
                resolution={resolution}
              />
              <RollingCard
                points={results.view.rolling}
                changes={results.view.changes.length}
                settings={settings}
                resolution={resolution}
                adjustment={adjustment}
                variable={variable}
              />
            </div>
            <EventStudyCard
              study={results.view.study}
              tests={results.view.events}
              settings={settings}
              stockSymbol={stockSymbol}
              threshold={threshold}
              variable={variable}
              adjustment={adjustment}
              resolution={resolution}
            />
          </>
        ))}

      <p className="text-xs text-ink-muted">
        Correlation, not causation: these figures describe how the two series moved together in this sample. They are
        not predictions or trading signals. Other news can move both at once.
      </p>
    </div>
  );
}

// ---- The link: every setting, and where the windows end ----

/** The primary test in one line, for a saved study: what it showed when saved. */
export function primaryHeadline(primary: TestResult | null): string | null {
  if (primary?.p == null) return null;
  return `r = ${fmtR(primary.estimate)} (95% CI ${formatCi(primary.ci, fmtR)}), p = ${formatP(primary.p)}`;
}

/** The jump sizes the panel opens with: the link's at the resolution it opens at, if it's one the variable offers. */
function linkedThresholds(variable: KalshiVariable, view: ResearchView | undefined): Record<Resolution, number> {
  const resolution: Resolution = view?.window === 7 ? "hourly" : (view?.resolution ?? "hourly");
  const jump = view?.jump ?? null;
  return jump !== null && variable.thresholds.includes(jump) ? { ...variable.defaultThreshold, [resolution]: jump } : variable.defaultThreshold;
}

/** The benchmark the panel opens with: the link's, or the default. */
function linkedBenchmark(view: ResearchView | undefined): BenchmarkChoice {
  return view?.benchmark && view.benchmark !== DEFAULT_BENCHMARK.symbol ? { symbol: view.benchmark, name: null } : DEFAULT_BENCHMARK;
}

/**
 * Keeps the address bar's link at the panel's settings, so it reproduces the view. Nothing is
 * rewritten on load: only after a setting changes (replaceState, so Back still leaves the analysis).
 */
function useLinkSync(view: ResearchView) {
  const key = JSON.stringify(view);
  const synced = useRef<string | null>(null);
  useEffect(() => {
    if (synced.current === null || synced.current === key) {
      synced.current = key;
      return;
    }
    synced.current = key;
    const analysis = analysisFromSearch(window.location.search);
    if (!analysis) return;
    const href = analysisHref(analysis, JSON.parse(key) as ResearchView);
    if (href !== window.location.pathname + window.location.search) window.history.replaceState(null, "", href);
  }, [key]);
}

/** Loads the analysis in the URL with these settings (a different as-of time loads its own data). */
function goTo(view: ResearchView) {
  const analysis = analysisFromSearch(window.location.search);
  if (analysis) window.location.assign(analysisHref(analysis, view));
}

/** Where the windows end, and the controls that freeze them there or load another as-of time. */
function FreezeControls({
  asOf,
  windowEnd,
  windowFrozen,
  frozenAt,
  closedAt,
  onFreeze,
  onLive,
  onLoad,
  subject,
}: {
  asOf: number;
  windowEnd: number | null;
  windowFrozen: boolean;
  frozenAt: number | null;
  closedAt: number | null;
  onFreeze: () => void;
  onLive: () => void;
  onLoad: (asOf: number) => void;
  /** "market’s" or "event’s first", for its close. */
  subject: string;
}) {
  const [picking, setPicking] = useState(false);
  const [input, setInput] = useState(() => newYorkInput(asOf));
  const [error, setError] = useState<string | null>(null);
  const when = (t: number) => formatDateTime(t, { withYear: true });
  const status =
    frozenAt !== null
      ? windowFrozen || windowEnd === null || frozenAt === windowEnd
        ? `Frozen as of ${when(asOf)}: this page’s link gives the same numbers later.`
        : `Frozen: the ${subject} close (${when(windowEnd)}) came before the link’s as-of time (${when(frozenAt)}), so the windows end at the close.`
      : windowEnd !== null
        ? `Windows end at the ${subject} close (${when(windowEnd)}).`
        : `Windows end now (${when(asOf)}), so the numbers change as new data arrives.`;

  function load() {
    const t = fromNewYorkInput(input);
    if (t === null) return setError("Enter a date and time.");
    if (t > Date.now()) return setError("Pick a time in the past.");
    if (t < Date.UTC(2015, 0, 1)) return setError("Pick a time in 2015 or later.");
    setError(null);
    onLoad(t);
  }

  const button =
    "inline-flex h-9 items-center rounded-md border border-border px-2.5 font-medium text-ink-secondary transition hover:bg-surface-raised hover:text-ink sm:h-7";
  return (
    <div className="grid gap-2">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <span role="status">{status}</span>
        {frozenAt === null ? (
          <button type="button" onClick={onFreeze} className={button} title="Puts this view’s time in the link: no reload, no data requests">
            Freeze at this view’s time
          </button>
        ) : (
          <button type="button" onClick={onLive} className={button}>
            Go live
          </button>
        )}
        <button type="button" onClick={() => setPicking((p) => !p)} className={button} aria-expanded={picking}>
          As of another time…
        </button>
      </div>
      {frozenAt === null && closedAt !== null && (
        <p>
          This market closed on {formatDate(closedAt)}: a frozen link’s windows end at its close, so its numbers can differ from
          these, which end now.
        </p>
      )}
      {picking && (
        <div className="flex flex-wrap items-end gap-2">
          <label className="grid gap-1">
            <span>As of (New York time)</span>
            <input
              type="datetime-local"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              className="h-10 rounded-lg border border-border bg-surface-raised px-2 text-base text-ink sm:h-8 sm:text-xs"
            />
          </label>
          <button type="button" onClick={load} className={button}>
            Load as of then
          </button>
          <span className="text-ink-muted">Reloads the analysis with the windows ending then: about 5 Twelve Data credits, like any analysis.</span>
          {error && <span className="text-down">{error}</span>}
        </div>
      )}
    </div>
  );
}

// ---- Summary and flags ----

/** Lowercases a sentence's first letter to continue a sentence, unless it starts a ticker (e.g. "TLT is …"). */
export const lowerFirst = (text: string) => (/^[A-Z][a-z]/.test(text) ? text.charAt(0).toLowerCase() + text.slice(1) : text);

/** How to read the sign of a correlation, for one market's YES side or an event's expected value. */
function SignNote({ stockSymbol, variable }: { stockSymbol: string; variable: KalshiVariable }) {
  if (variable.kind === "expected") {
    return (
      <p className="mt-3 text-xs text-ink-secondary">
        <span className="font-medium text-ink">How to read the sign.</span> Positive means {stockSymbol} tended to rise when{" "}
        {variable.text.rose}; negative, that it tended to fall.
      </p>
    );
  }
  return (
    <p className="mt-3 text-xs text-ink-secondary">
      <span className="font-medium text-ink">How to read the sign.</span> Positive means {stockSymbol} tended to rise
      when the chance of YES rose; negative means it tended to fall. Here, YES = “{variable.yesLabel}”. If YES is bad news for{" "}
      {stockSymbol}, negative values are what you’d expect.
    </p>
  );
}

export function sampleFlags(stats: CorrelationStats, variable: KalshiVariable): string[] {
  const flags: string[] = [];
  if (stats.flag === "insufficient") flags.push(`Too few intervals to analyze (n = ${stats.n}; at least 10 needed)`);
  else if (stats.flag === "small") flags.push(`Small sample (n = ${stats.n}): results can swing a lot by chance`);
  if (stats.noVariation) flags.push(`${variable.text.value} didn't change, so there's no correlation to measure`);
  else if (stats.n > 0 && stats.fewKalshiMoves) flags.push(`${variable.text.subject} moved in only ${stats.kalshiMoves} intervals: a few moves decide the results`);
  return flags;
}

/** e.g. "beta 1.18 from the full 90 days (n = 412 hourly intervals), not only this window". */
export function betaFrom(model: MarketModel, resolution: Resolution, sample: ModelSample): string {
  return `beta ${model.beta.toFixed(2)} from ${modelSample(model, resolution, sample)}${sample.kind === "loaded" && sample.days < 90 ? ", not only this window" : ""}`;
}

/** The adjustment in one sentence, for a chart's small print. */
export function adjustmentNote({ benchmark, model, sample }: Adjustment, stockSymbol: string, resolution: Resolution): string {
  return `Market-adjusted: ${stockSymbol}’s return minus (alpha + beta × ${benchmark}’s return), with ${betaFrom(model, resolution, sample)}.`;
}

/**
 * Says when a window is cut short by the market's life (no window reaches back before it opened),
 * or All by the most stock history one request holds; null when the window covers its whole length.
 */
function windowNote(
  choice: WindowChoice,
  plan: WindowPlan,
  long: Result<LongRows | null> | null,
  opened: number | null,
  asOf: number,
  subject: string,
): string | null {
  const days = (from: number) => Math.round((asOf - from) / DAY_MS);
  const same = plan.kind === "loaded" && plan.sameAs90 ? ", the same as 90D" : "";
  if (choice === "all") {
    const start = long?.ok && long.data ? long.data.start : null;
    if (opened !== null && start !== null && start > opened + DAY_MS) {
      return `All reaches back ${days(start)} days, to ${formatDate(start)}: the most history one request of stock bars holds. ${subject} opened ${formatDate(opened)}.`;
    }
    return opened === null ? null : `All covers the whole life since ${lowerFirst(subject)} opened on ${formatDate(opened)}: ${days(opened)} days${same}.`;
  }
  if (opened !== null && opened > asOf - choice * DAY_MS) {
    return `${subject} opened on ${formatDate(opened)}, so the ${WINDOW_LABEL[choice]} window covers only ${days(opened)} days${choice > 90 ? same : ""}.`;
  }
  return null;
}

function Summary({
  changes,
  excluded,
  stats,
  resolution,
  settings,
  adjustment,
  rawR,
  variable,
}: {
  changes: ChangePoint[];
  excluded: ChangeSeries["excluded"];
  stats: CorrelationStats;
  resolution: Resolution;
  settings: Settings;
  adjustment: Adjustment | null;
  rawR: number | null;
  variable: KalshiVariable;
}) {
  const intervalNoun: [string, string] = resolution === "hourly" ? ["hourly interval", "hourly intervals"] : ["daily interval", "daily intervals"];
  const range = changes.length > 0 ? ` (${formatShortDate(changes[0].t)} – ${formatShortDate(changes[changes.length - 1].t)})` : "";
  const left = Object.entries(excluded)
    .filter(([, n]) => n > 0)
    .map(([reason, n]) => `${n.toLocaleString("en-US")} ${EXCLUSION_LABEL[resolution][reason] ?? reason}`);
  if (adjustment && adjustment.missingBenchmark > 0) {
    left.push(`${adjustment.missingBenchmark.toLocaleString("en-US")} without a ${adjustment.benchmark} price at both ends`);
  }
  const flags = sampleFlags(stats, variable);
  return (
    <div className="mt-4 text-sm text-ink-secondary">
      <p>
        <span className="font-semibold text-ink">{plural(changes.length, intervalNoun)}</span>
        {range}, {variable.text.subject} moved in {plural(stats.kalshiMoves, [settings.noun[0], settings.noun[1]])}.
        {stats.r !== null && (
          <>
            {" "}
            {settings.same} correlation{adjustment && `, market-adjusted vs. ${adjustment.benchmark}`}:{" "}
            <span className="font-semibold text-ink">{fmtR(stats.r)}</span>
            {adjustment && ` (raw ${fmtR(rawR)})`}.
          </>
        )}
      </p>
      {adjustment && (
        <p className="mt-1 text-xs text-ink-secondary">
          Market-adjusted returns use {betaFrom(adjustment.model, resolution, adjustment.sample)}.
        </p>
      )}
      {left.length > 0 && <p className="mt-1 text-xs text-ink-muted">Left out: {left.join(" · ")}.</p>}
      {resolution === "hourly" && (
        <p className="mt-1 text-xs text-ink-muted">
          Hourly mode uses trading hours only (10 AM–4 PM New York), so overnight moves and the first half hour aren’t
          included. Daily mode compares close to close, including overnight moves.
        </p>
      )}
      {flags.length > 0 && (
        <div className="mt-3 flex flex-wrap gap-2">
          {flags.map((f) => (
            <Flag key={f}>{f}</Flag>
          ))}
        </div>
      )}
    </div>
  );
}

// ---- Primary test ----

/**
 * The one test the page is set up to answer: same-period correlation of Kalshi changes with
 * market-adjusted returns, judged on its own p-value. Shown whichever returns are selected.
 */
function PrimaryTest({
  primary,
  detectable,
  fragility,
  leaveOneOut,
  pending,
  significant,
  fewRuns,
  longDaily,
  unavailable,
  benchmark,
  stockSymbol,
  settings,
  variable,
  resolution,
}: {
  primary: TestResult | null;
  /** For a result that isn't significant: the smallest correlation this sample could detect. */
  detectable: DetectableCorrelation | null;
  fragility: Fragility | null;
  leaveOneOut: LeaveOneOut | null;
  /** The detectable size and leave-one-out check are still computing (shown after a moment). */
  pending: boolean;
  significant: boolean;
  /** About 10 runs of days (30 days daily), where the detectable size was validated as unreliable. */
  fewRuns: boolean;
  /** Daily data over a window past 90 days, where the intervals covered less than 95% in validation. */
  longDaily: boolean;
  /** Why market adjustment isn't available, when it isn't. */
  unavailable: string;
  benchmark: string;
  stockSymbol: string;
  settings: Settings;
  variable: KalshiVariable;
  resolution: Resolution;
}) {
  const missing = primary === null ? null : unavailableText(primary);
  return (
    <div className="mt-4 rounded-lg border border-border p-3">
      <div className="flex flex-wrap items-center gap-2">
        <RoleBadge role="primary" />
        <span className="text-sm font-medium text-ink">
          {settings.same} correlation of {variable.kind === "probability" ? "Kalshi changes" : "ΔE"} with {stockSymbol}’s market-adjusted returns
          {primary && ` (vs. ${benchmark})`}
        </span>
      </div>
      {primary === null ? (
        <p className="mt-2 text-sm text-ink-secondary">
          No primary test: {lowerFirst(unavailable)}, so there are no market-adjusted returns
          to test. Every result below is exploratory.
        </p>
      ) : (
        <>
          <p className="mt-2 text-sm text-ink-secondary">
            <ResultLine test={primary} label="r" format={fmtR} />
            {primary.p !== null && (
              <>
                : <span className="font-medium text-ink">{verdict(primary, "raw")}</span>
              </>
            )}
            .
          </p>
          {detectable ? (
            <DetectableLine detectable={detectable} fewRuns={fewRuns} />
          ) : (
            !significant &&
            pending && (
              <p role="status" className="mt-1 text-sm text-ink-muted">
                Working out the smallest correlation this sample could detect…
              </p>
            )
          )}
          <p className="mt-1 text-xs text-ink-muted">
            {missing ?? methodText(primary)} This is the question the page is set up to answer, chosen before looking at the data,
            so it’s judged on its own p-value. Everything else on the page is exploratory: corrected for the other tests in its
            chart, and best treated as leads to check, not findings. Switching window, resolution, or benchmark until something
            looks significant isn’t corrected for.
            {longDaily && primary.p !== null && (
              <>
                {" "}
                <strong className="font-medium text-ink-secondary">Daily data over a long window runs a little liberal:</strong> in
                simulations with a year of trading days, these 95% intervals covered the true value only {LONG_DAILY_COVERAGE} of the time,
                and with no link {LONG_DAILY_FALSE_POSITIVES} came out below 0.05. Read the interval as somewhat too narrow.
              </>
            )}
          </p>
          {fragility && (
            <FragilityBlock fragility={fragility} leaveOneOut={leaveOneOut} pending={pending} primary={primary} variable={variable} resolution={resolution} />
          )}
        </>
      )}
    </div>
  );
}

const pct = (share: number) => `${Math.round(share * 100)}%`;
export const REASON_TEXT: Record<FragileReason, string> = {
  movement: "a few intervals carry most of the movement",
  leave_one_out: "leaving out one session changes the decision",
};

// From fragility-rates.sim.test.ts: how often the warning (F1 or F3) came on in hourly simulations with
// no real relationship, 200 data sets per window.
export const WARNING_BY_CHANCE =
  "11.5% of data sets over a year and 13.0% over 180 days, but 22.5% over 90 days and 75.0% over 30 days, where few intervals carry Kalshi's movement";
// The same runs, for the pre-set F2 check taken out of the warning on 2026-10-19.
export const F2_BY_CHANCE = "98.5% of data sets at 90 days and 61% at a year";

/** When an interval ran: its New York date and hours (hourly), or the session it closed (daily). */
export function intervalText(t: number, resolution: Resolution): string {
  if (resolution === "daily") return `${formatDate(t)} (close to close)`;
  return `${formatDate(t)}, ${formatTime(t - 60 * 60 * 1000)}–${formatTime(t)}`;
}

/** When a session or run of days was. */
export function sessionText(from: number, to: number, resolution: Resolution): string {
  if (resolution === "hourly") return formatDate(from);
  return formatShortDate(from) === formatShortDate(to) ? formatDate(to) : `${formatShortDate(from)} – ${formatDate(to)}`;
}

/**
 * How much the primary result rests on a few intervals and sessions (lib/analytics/fragility.ts),
 * with a warning at thresholds fixed before any result was seen.
 */
export function FragilityBlock({
  fragility: f,
  leaveOneOut: loo,
  pending,
  primary,
  variable,
  resolution,
}: {
  fragility: Fragility;
  leaveOneOut: LeaveOneOut | null;
  pending: boolean;
  primary: TestResult;
  variable: KalshiVariable;
  resolution: Resolution;
}) {
  const reasons = fragileReasons(f, loo);
  const blocks: [string, string] = f.unit === "day_run" ? ["run of days", "runs of days"] : ["session", "sessions"];
  const intervals: [string, string] = resolution === "hourly" ? ["hour", "hours"] : ["day", "days"];
  const mover = variable.kind === "probability" ? "Kalshi’s probability" : "E";
  const decision = (t: TestResult) => (t.p === null ? "no p-value" : t.p < ALPHA ? "p < 0.05" : "p ≥ 0.05");
  const runText = (t: TestResult) => (t.p === null ? "no p-value (too few left)" : `r = ${fmtR(t.estimate)}, p = ${formatP(t.p)}`);
  return (
    <div className="mt-3 border-t border-border pt-3 text-sm text-ink-secondary">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-medium text-ink">How much it rests on a few {intervals[1]}</span>
        {reasons.length > 0 ? (
          <Flag>Fragile: {reasons.map((r) => REASON_TEXT[r]).join("; ")}</Flag>
        ) : (
          loo && <span className="text-xs text-ink-muted">No fragility warning</span>
        )}
      </div>
      <ul className="mt-1.5 list-disc space-y-1 pl-5">
        <li>
          {mover}’s movement: the largest {intervals[0]} carries {pct(f.movement.top1)} of its variation in this window, and the largest 5
          carry {pct(f.movement.top5)}, as concentrated as {f.movement.effective.toFixed(1)} equal {intervals[1]} (of{" "}
          {f.movement.intervals.toLocaleString("en-US")}; it moved in {f.movement.moves.toLocaleString("en-US")}).
        </li>
        <li>
          The test: the most influential {blocks[0]} carries {pct(f.sessions.top1)} of the bootstrap’s score, the top 5 carry{" "}
          {pct(f.sessions.top5)}, and the top 10 {pct(f.sessions.top10)}, as concentrated as {f.sessions.effective.toFixed(1)} equal{" "}
          {blocks[1]} (of {f.sessions.count}). Shown as a description, not part of the warning (see below).
        </li>
        <li>
          {loo ? (
            <>
              Leaving out each of the {loo.runs.length} most influential {blocks[1]} in turn: r from {fmtR(loo.estimate?.[0] ?? null)} to{" "}
              {fmtR(loo.estimate?.[1] ?? null)}
              {loo.p && (
                <>
                  , p from {formatP(loo.p[0])} to {formatP(loo.p[1])}
                </>
              )}
              ;{" "}
              {loo.flips === 0 ? (
                "the decision at 5% never changes"
              ) : (
                <span className="font-medium text-ink">
                  the decision at 5% changes in {loo.flips} of {loo.runs.length}
                </span>
              )}
              {loo.unavailable > 0 && ` (${loo.unavailable} left too few ${blocks[1]} for a p-value)`}. Without all {loo.runs.length} at once:{" "}
              {runText(loo.together)}.
            </>
          ) : pending ? (
            <span role="status" className="text-ink-muted">
              Leaving out each of the most influential {blocks[1]} in turn…
            </span>
          ) : (
            <span className="text-ink-muted">Leaving out each of the most influential {blocks[1]} in turn…</span>
          )}
        </li>
      </ul>
      <details className="mt-2 text-xs">
        <summary className="cursor-pointer text-ink-secondary hover:text-ink">The most influential {blocks[1]} and {intervals[1]}, with times to look up the news</summary>
        <div className="mt-2 grid gap-3">
          <Table
            head={["#", blocks[0].charAt(0).toUpperCase() + blocks[0].slice(1), "Share of score", "Pushes r", `Without it`, "Decision"]}
            rows={f.sessions.ranked.map((s, i) => {
              const run = loo?.runs[i];
              return [
                String(i + 1),
                sessionText(s.from, s.to, resolution),
                pct(s.share),
                s.score > 0 ? "up" : "down",
                run ? runText(run.test) : "…",
                run ? `${decision(run.test)}${run.flips ? " (changes)" : ""}` : "…",
              ];
            })}
          />
          <Table
            head={[resolution === "hourly" ? "Hour (New York)" : "Day", variable.kind === "probability" ? "Kalshi change" : "ΔE", "Abnormal return", "Share", "Pushes r", `${blocks[0].charAt(0).toUpperCase() + blocks[0].slice(1)} rank`]}
            rows={f.hours.map((h) => [
              intervalText(h.t, resolution),
              formatSigned(h.kalshiChange, 2, ` ${variable.unit}`),
              formatSigned(h.abnormal * 100, 2, "%"),
              pct(h.share),
              h.contribution > 0 ? "up" : "down",
              `#${h.sessionRank}`,
            ])}
          />
        </div>
      </details>
      <p className="mt-2 text-xs text-ink-muted">
        Diagnostics, not tests: they say how much this result rests on a few {intervals[1]}, not whether it’s right. An {intervals[0]}’s share
        is its part of {mover}’s variation (its weight in the correlation); a {blocks[0]}’s is its part of the variance of the
        bootstrap’s score under the null. “As concentrated as” counts are Kish’s effective numbers, (Σw)² / Σw². The warning uses
        thresholds fixed before any results were seen: fewer than {FRAGILE.minEffectiveMoves} equal {intervals[1]} of movement (where
        the page already says a few moves decide), or a decision at 5% that changes when one of the {FRAGILE.leaveOut} most influential{" "}
        {blocks[1]} is left out (alpha and beta refitted without it). A p-value near 0.05 can also cross it from Monte Carlo error
        alone (about ±0.007 with {(primary.resampling?.draws ?? 999).toLocaleString("en-US")} draws).{" "}
        <span className="font-medium text-ink-secondary">It comes on by chance too:</span> in hourly simulations with no real
        relationship, it came on in {WARNING_BY_CHANCE}.
      </p>
      <p className="mt-1 text-xs text-ink-muted">
        <span className="font-medium text-ink-secondary">Changed on Oct 19, 2026, from the pre-set thresholds:</span> the warning no
        longer counts fewer than {DESCRIPTIVE_MIN_SESSIONS} equal {blocks[1]}, which is still shown above as a description. In simulations
        with no real relationship it came on in {F2_BY_CHANCE}, because most {blocks[1]} have no Kalshi movement, so as a warning it
        carried no information. The change was based only on simulated data, not on any real result.
      </p>
    </div>
  );
}

// From long-windows.sim.test.ts, daily with 252 trading days: the primary test's interval covered the
// true effect in 180 of 200 data sets (below the 92% bar set beforehand, so shown here), and with no
// link 28 of 400 had p < 0.05 (within the 7.5% bar, but above 5%).
export const LONG_DAILY_COVERAGE = "90% (180 of 200, 95% range 85–93%)";
export const LONG_DAILY_FALSE_POSITIVES = "7.0% (28 of 400, 95% range 4.9–9.9%)";

/** The smallest correlation the primary test could detect with 80% power in this sample. */
// From power.test.ts, on validation seeds: with 20 daily intervals (about 10 runs of days), effects of the
// size reported were detected in 27 of 60 fresh samples, far below the 80% the figure claims.
export const UNRELIABLE_DAILY = "45% (27 of 60, 95% range 33–58%)";

export function DetectableLine({ detectable, fewRuns }: { detectable: DetectableCorrelation; fewRuns: boolean }) {
  const units = plural(detectable.units, detectable.unit === "day_run" ? ["run of days", "runs of days"] : ["session", "sessions"]);
  const power = `${Math.round(detectable.power * 100)}%`;
  return (
    <p className="mt-1 text-sm text-ink-secondary">
      {detectable.r === null ? (
        <>
          With these {units}, only a correlation stronger than about ±{detectable.max.toFixed(1)} would be detected {power} of the
          time, so this result says little either way.
        </>
      ) : (
        <>
          With these {units}, a correlation of about <span className="font-semibold text-ink">±{detectable.r.toFixed(2)}</span> or
          larger would be detected {power} of the time, so this result says little about smaller ones.
        </>
      )}
      <span className="mt-0.5 block text-xs text-ink-muted">
        A rough guide, simulated from this sample: {detectable.samples.toLocaleString("en-US")} versions with Kalshi’s changes and
        the stock’s volatility as observed and an effect built in, allowing for how uncertain that volatility is.
        {fewRuns && detectable.r !== null && (
          <>
            {" "}
            <strong className="font-medium text-ink-secondary">Unreliable with this few runs of days:</strong> in simulations with
            20 daily intervals, effects of the size shown were detected only {UNRELIABLE_DAILY} of the time, not 80%.
          </>
        )}
      </span>
    </p>
  );
}

// ---- Chart cards ----

export function when(lag: number, settings: Settings, subject: string): string {
  const n = Math.abs(lag);
  const span = plural(n, settings.noun);
  if (lag === 0) return `${subject} in the same ${settings.noun[0]}`;
  return lag > 0 ? `${subject} ${span} later` : `${subject} ${span} earlier`;
}

function LeadLagCard({
  lags,
  adjustedBy,
  settings,
  stockSymbol,
  variable,
  adjustment,
  resolution,
}: {
  lags: LagCorrelation[];
  /** The benchmark when lag 0 is the primary test (market-adjusted returns), else null. */
  adjustedBy: string | null;
  settings: Settings;
  stockSymbol: string;
  variable: KalshiVariable;
  adjustment: Adjustment | null;
  resolution: Resolution;
}) {
  const returnNoun = adjustment ? "market-adjusted return" : "return";
  const measured = lags.filter((l) => l.r !== null);
  const family = lags.filter((l) => l.test.role === "exploratory");
  const tested = family.filter((l) => l.test.p !== null);
  const fmt = (l: LagCorrelation) => formatLag(l.lag, settings.unit);
  const passing = tested.filter((l) => passes(l.test, "bh")).sort((a, b) => a.test.p! - b.test.p!);
  const smallest = tested.reduce<LagCorrelation | null>((a, b) => (a === null || b.test.holm! < a.test.holm! ? b : a), null);
  const withMethod = lags.find((l) => l.test.p !== null) ?? lags.find((l) => l.test.pUnavailable === "too_few_blocks");

  let lead: ReactNode;
  if (measured.length === 0) {
    lead = "Not enough matching intervals at any lag to measure a correlation.";
  } else if (tested.length === 0) {
    lead = withMethod ? unavailableText(withMethod.test) : "No lag has a p-value.";
  } else if (passing.length > 0) {
    const [top, ...others] = passing;
    lead = (
      <>
        After correcting for the {tested.length} lags tested, {passing.length === 1 ? "one passes" : `${passing.length} pass`}: at{" "}
        {fmt(top)}, {variable.kind === "probability" ? "Kalshi changes" : "ΔE"} tended to move {top.r! > 0 ? "in the same direction as" : "opposite to"}{" "}
        {when(top.lag, settings, `${stockSymbol}’s ${returnNoun}`)} (r = {fmtR(top.r)}, 95% CI {formatCi(top.test.ci, fmtR)}, Holm
        p = {formatP(top.test.holm)}, BH p = {formatP(top.test.bh)}).
        {others.length > 0 && ` Also ${others.map(fmt).join(", ")}.`} Exploratory: a lead to check, not a finding.
      </>
    );
  } else {
    const uncorrected = tested.filter((l) => passes(l.test, "raw"));
    lead = (
      <>
        No lag passes correction for the {tested.length} tested (smallest Holm-adjusted p: {formatP(smallest!.test.holm)} at{" "}
        {fmt(smallest!)}).
        {uncorrected.length > 0 &&
          ` Uncorrected, ${uncorrected.map((l) => `${fmt(l)} has p = ${formatP(l.test.p)}`).join(" and ")}: about what chance produces across ${tested.length} tests.`}
      </>
    );
  }

  return (
    <Card title="Lead-lag" subtitle={`Correlation of ${variable.kind === "probability" ? "Kalshi changes" : "ΔE"} with ${stockSymbol} ${returnNoun}s, shifted by ${settings.noun[1]}`}>
      {measured.length === 0 ? (
        <Notice tone="info" title="Not enough data" message="Each lag needs at least 10 matching intervals, with some movement in both series." />
      ) : (
        <LeadLagChart lags={lags} unit={settings.unit} />
      )}
      <Caption
        lead={lead}
        caveats={
          <>
            Right of 0: {variable.text.subject} moved first. Left of 0: {stockSymbol} moved first. Whiskers are 95% intervals; one that reaches
            ±1 means Kalshi’s moves at that lag fall in too few {resolution === "hourly" ? "sessions" : "runs of days"} to pin the
            correlation down.{" "}
            <strong className="font-medium text-ink-secondary">
              Exploratory: corrected as one family, the {family.length} exploratory lags on this chart
              {adjustedBy && " (lag 0 is the primary test, judged on its own)"}.
            </strong>{" "}
            Holm keeps the chance of any false positive among them at 5%; Benjamini–Hochberg (BH) keeps the expected share of
            false positives among those that pass at 5%. Neighboring lags share most of their data, which makes Holm cautious.{" "}
            {withMethod && withMethod.test.p !== null && methodText(withMethod.test)}{" "}
            {variable.kind === "probability" ? "Kalshi’s changes" : "ΔE values"} are left as observed, zeros and all. {variable.text.sign}
            {adjustment && ` ${adjustmentNote(adjustment, stockSymbol, resolution)}`}
          </>
        }
      />
      <ValuesTable
        head={["Lag", ...TEST_COLUMNS.map((c) => (c === "Estimate" ? "r" : c === "n" ? "Pairs" : c))]}
        rows={lags.map((l) => [fmt(l) + (l.test.role === "primary" ? " (primary)" : ""), ...testCells(l.test, fmtR)])}
      />
    </Card>
  );
}

function RollingCard({
  points,
  changes,
  settings,
  resolution,
  adjustment,
  variable,
}: {
  points: RollingPoint[];
  changes: number;
  settings: Settings;
  resolution: Resolution;
  adjustment: Adjustment | null;
  variable: KalshiVariable;
}) {
  const w = settings.rollingWindow;
  const rs = points.map((p) => p.r).filter((r): r is number => r !== null);
  const enough = changes >= w + ROLLING_EXTRA && rs.length > 0;
  const latest = points.at(-1)?.r ?? null;
  return (
    <Card
      title="Rolling correlation"
      subtitle={`${settings.same} correlation over the last ${w} intervals (${settings.rollingSpan})${
        adjustment ? `, market-adjusted vs. ${adjustment.benchmark}` : ""
      }`}
    >
      {enough ? (
        <RollingCorrelationChart points={points} daily={resolution === "daily"} />
      ) : (
        <Notice
          tone="info"
          title="Not enough data for a rolling view"
          message={`This needs at least ${w + ROLLING_EXTRA} usable intervals; this window has ${changes}. Try a longer window${
            resolution === "daily" ? " or hourly data" : ""
          }.`}
        />
      )}
      <Caption
        lead={
          enough
            ? `How the correlation moved over time: from ${fmtR(Math.min(...rs))} to ${fmtR(Math.max(...rs))} (latest ${fmtR(latest)}).`
            : "Shows how the correlation moved over time."
        }
        caveats={
          <>
            <strong className="font-medium text-ink-secondary">Descriptive only: no significance is claimed.</strong> Each point
            uses just {w} intervals and shares {w - 1} of them with the next, so the line moves smoothly by construction and its
            swings aren’t independent evidence; with so few intervals, large swings happen by chance alone. For tests, see the
            primary test and the lead-lag chart.
            {points.some((p) => p.r === null) && " Gaps: one series didn't move in that window."}{" "}
            {variable.kind === "probability" ? "The sign depends on what YES means (see above)." : variable.text.sign}
            {adjustment && ` Every window uses the same ${betaFrom(adjustment.model, resolution, adjustment.sample)}.`}
          </>
        }
      />
    </Card>
  );
}

/** Warnings for a group with few events: none, too few for any test, or rough intervals. */
export function eventFlag(name: string, group: GroupTests | undefined, n: number): string | null {
  if (n === 0) return null;
  if (n < MIN_TEST_EVENTS) return `Only ${plural(n, [name, `${name}s`])}: too few for intervals or p-values to mean much`;
  if (n >= SMALL_EVENT_COUNT) return null;
  const minP = group?.path.resampling?.minP ?? null;
  return `Only ${n} ${name}s: intervals are rough${
    minP !== null ? `, and the smallest possible p is ${formatMinP(minP)}${minP >= 0.05 ? ", so none can reach 5%" : ""}` : ""
  }`;
}

function EventStudyCard({
  study,
  tests,
  settings,
  stockSymbol,
  threshold,
  variable,
  adjustment,
  resolution,
}: {
  study: EventStudy | null;
  tests: EventStudyTests | null;
  settings: Settings;
  stockSymbol: string;
  threshold: number;
  variable: KalshiVariable;
  adjustment: Adjustment | null;
  resolution: Resolution;
}) {
  const kind = adjustment ? "market-adjusted return" : "return";
  const card = (children: ReactNode) => (
    <Card
      title={variable.kind === "probability" ? "Around Kalshi jumps" : "Around jumps in E"}
      subtitle={`Average ${stockSymbol} cumulative ${kind} in the ${settings.noun[1]} before and after ${variable.text.moved} moved ≥${threshold} ${variable.unit} in one ${settings.noun[0]}`}
    >
      {children}
    </Card>
  );
  if (study === null || tests === null) {
    return card(
      <Notice
        tone="info"
        title="Not enough data for a market-adjusted event study"
        message={`Fewer than 10 ${resolution} intervals in the market model’s sample fall outside the jump windows, so beta can’t be estimated without the jumps shaping it. Try a larger jump size, or Raw.`}
      />,
    );
  }
  const last = study.offsets.length - 1;
  const end = formatLag(study.offsets[last], settings.unit);
  const at = (mean: number[] | null) => formatSigned(mean?.[last] ?? null, 2, "%");
  const parts = [
    study.rises.n > 0 && `after rises, ${stockSymbol} averaged ${at(study.rises.mean)}`,
    study.falls.n > 0 && `after falls, ${at(study.falls.mean)}`,
  ].filter(Boolean);
  const skipped = study.skippedOverlap + study.skippedEdge + study.skippedMissing;
  const flags = [eventFlag("rise", tests.rises, study.rises.n), eventFlag("fall", tests.falls, study.falls.n)].filter(
    (f): f is string => f !== null,
  );
  const pathText = (name: string, t: TestResult) =>
    t.p === null ? null : `after ${name}, p = ${formatP(t.p)} (Holm ${formatP(t.holm)}, BH ${formatP(t.bh)})`;
  const paths = [pathText("rises", tests.rises.path), pathText("falls", tests.falls.path)].filter(Boolean);
  const method = [tests.rises.path, tests.falls.path].find((t) => t.p !== null);
  const pct = (v: number) => formatSigned(v, 2, "%");
  const cell = (t: TestResult | null) =>
    t === null ? ["—", "—", "—"] : [t.estimate === null ? "—" : pct(t.estimate), formatCi(t.ci, pct), t.p === null ? "—" : `${formatP(t.p)} (${formatP(t.bh)})`];

  return card(
    <>
      {flags.length > 0 && (
        <div className="mb-3 flex flex-wrap gap-2">
          {flags.map((f) => (
            <Flag key={f}>{f}</Flag>
          ))}
        </div>
      )}
      <EventStudyChart
        study={study}
        tests={tests}
        unit={settings.unit}
        stockSymbol={adjustment ? `${stockSymbol} market-adjusted` : stockSymbol}
        threshold={threshold}
        variable={variable}
      />
      <Caption
        lead={
          <>
            Compare each line with the dashed baseline (the stock’s normal drift over any window this long), not with zero.
            {parts.length > 0 && ` By ${end}, ${parts.join("; ")}, vs. ${at(study.baseline.mean)} for the baseline.`}
            {paths.length > 0 && ` Whole path against the baseline: ${paths.join("; ")}.`}
          </>
        }
        caveats={
          <>
            <strong className="font-medium text-ink-secondary">Exploratory. {eventFamilyText(tests)}</strong>{" "}
            Shaded: 95% intervals for the average path. Filled dots: bars whose BH-adjusted p is below 5%. Each bar’s test asks
            whether the paths after jumps differ from the baseline; the whole-path test asks whether they differ anywhere in the
            window (the largest deviation, judged against how large it gets by chance).{" "}
            {method && methodText(method)} A jump’s own volatility counts against it, so a stock that’s merely jumpier around news
            doesn’t pass. Based on {plural(study.rises.n, ["rise", "rises"])} and {plural(study.falls.n, ["fall", "falls"])}{" "}
            {variable.text.movesIn}. Paths start at the close before the jump (bar −1); the shaded bar is the{" "}
            {settings.noun[0]} the jump happened in. {settings.barNote}
            {skipped > 0 &&
              ` ${plural(skipped, ["jump was", "jumps were"])} skipped (within ${settings.eventBars} bars of an earlier jump, or too close to the edge of the data${
                study.skippedMissing > 0 && adjustment ? `, or missing a ${adjustment.benchmark} price` : ""
              }).`}
            {adjustment?.eventModel &&
              ` Market-adjusted with beta ${adjustment.eventModel.beta.toFixed(2)} and alpha from ${modelSample(adjustment.eventModel, resolution, adjustment.sample)} outside every jump window, so the jumps don’t shape beta; the baseline is adjusted the same way.`}
          </>
        }
      />
      <ValuesTable
        head={["Bar", "Rises vs. baseline", "Rises 95% CI", "Rises p (BH)", "Falls vs. baseline", "Falls 95% CI", "Falls p (BH)", "Baseline"]}
        rows={study.offsets.map((k, i) => [
          formatLag(k, settings.unit),
          ...cell(tests.rises.bars[i]),
          ...cell(tests.falls.bars[i]),
          formatSigned(study.baseline.mean?.[i] ?? null, 2, "%"),
        ])}
      />
    </>,
  );
}
