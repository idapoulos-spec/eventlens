"use client";

import { useMemo, useState, type ReactNode } from "react";
import {
  computeChanges,
  crossCorrelation,
  eventStudy,
  eventStudyTests,
  marketAdjustment,
  MIN_TEST_EVENTS,
  passes,
  researchCsv,
  rollingCorrelation,
  rowsSince,
  SMALL_EVENT_COUNT,
  type ChangePoint,
  type ChangeSeries,
  type CorrelationStats,
  type EventStudy,
  type EventStudyTests,
  type GroupTests,
  type LagCorrelation,
  type MarketModel,
  type Resolution,
  type ResearchRow,
  type RollingPoint,
  type TestResult,
} from "@/lib/analytics";
import { formatShortDate, formatSigned } from "@/lib/format";
import type { BenchmarkSeries } from "@/lib/market-data/types";
import type { Result } from "@/lib/result";
import { EventStudyChart } from "../charts/EventStudyChart";
import { formatLag, LeadLagChart, type LagUnit } from "../charts/LeadLagChart";
import { RollingCorrelationChart } from "../charts/RollingCorrelationChart";
import { Card, Notice } from "../ui";
import { MarketAdjustmentCard, modelSample } from "./MarketAdjustmentCard";
import { Caption, Flag, fmtR, plural, Segmented, ValuesTable } from "./parts";
import {
  familyText,
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
import { useBenchmark } from "./useBenchmark";

const DAY_MS = 24 * 60 * 60 * 1000;
const WINDOWS = [7, 30, 90] as const;
type WindowDays = (typeof WINDOWS)[number];
const THRESHOLDS = [1, 2, 3, 5, 10];

interface Settings {
  unit: LagUnit;
  /** Singular and plural names of one interval. */
  noun: [string, string];
  /** e.g. "Same-hour correlation". */
  same: string;
  /** What an event-study bar spans. */
  barNote: string;
  maxLag: number;
  rollingWindow: number;
  rollingSpan: string;
  eventBars: number;
  defaultThreshold: number;
}

const SETTINGS: Record<Resolution, Settings> = {
  hourly: {
    unit: "h",
    noun: ["hour", "hours"],
    same: "Same-hour",
    barNote: "Bars are trading hours, so a window can span a night or weekend.",
    maxLag: 3,
    rollingWindow: 18,
    rollingSpan: "about 3 sessions",
    eventBars: 6,
    defaultThreshold: 2,
  },
  daily: {
    unit: "d",
    noun: ["trading day", "trading days"],
    same: "Same-day",
    barNote: "Bars are trading days.",
    maxLag: 5,
    rollingWindow: 20,
    rollingSpan: "about a month",
    eventBars: 5,
    defaultThreshold: 3,
  },
};

// A rolling view needs this many intervals beyond one window to show any change over time.
const ROLLING_EXTRA = 10;

const EXCLUSION_LABEL: Record<Resolution, Record<string, string>> = {
  hourly: {
    non_trading: "across nights, weekends, or halts",
    before_kalshi: "before Kalshi's first price in the loaded history",
    market_closed: "after the market closed",
    kalshi_last_price: "priced from a last trade (one-sided book)",
  },
  daily: {
    non_trading: "across a missing session",
    before_kalshi: "before Kalshi's first price in the loaded history",
    market_closed: "after the market closed",
    kalshi_last_price: "priced from a last trade (one-sided book)",
  },
};

interface Props {
  hourly: ResearchRow[];
  daily: ResearchRow[];
  /** When the stock data was fetched: windows count back from here. */
  asOf: number;
  stockSymbol: string;
  kalshiTicker: string;
  /** What a YES outcome means for this market, quoted in the sign notes. */
  yesLabel: string;
  /** The default benchmark as the server loaded it, or null if it wasn't requested (the stock is the benchmark). */
  initialBenchmark: Result<BenchmarkSeries> | null;
}

/** Raw: the stock's own returns. Adjusted: net of the benchmark (alpha + beta × its return). */
type Returns = "raw" | "adjusted";

/** What the lead-lag, rolling, and event-study cards show. */
interface View {
  changes: ChangePoint[];
  lags: LagCorrelation[];
  sameInterval: CorrelationStats;
  rolling: RollingPoint[];
  /** Null in market-adjusted mode when beta can't be estimated outside the jump windows. */
  study: EventStudy | null;
  events: EventStudyTests | null;
}

/** How the market-adjusted view was adjusted, for its captions. */
interface Adjustment {
  benchmark: string;
  model: MarketModel;
  eventModel: MarketModel | null;
  missingBenchmark: number;
  /** The selected window, in days. */
  days: number;
}

/**
 * Every result one set of changes gives. In market-adjusted mode lag 0 is the primary test,
 * so it's left out of the lead-lag family the other lags are corrected in.
 */
function view(changes: ChangePoint[], study: EventStudy | null, settings: Settings, resolution: Resolution, adjusted: boolean): View {
  const lags = crossCorrelation(changes, settings.maxLag, resolution, { primaryLag: adjusted ? 0 : undefined });
  return {
    changes,
    lags,
    sameInterval: lags.find((l) => l.lag === 0)!,
    rolling: rollingCorrelation(changes, settings.rollingWindow),
    study,
    events: study && eventStudyTests(study),
  };
}

export function ResearchPanel({ hourly, daily, asOf, stockSymbol, kalshiTicker, yesLabel, initialBenchmark }: Props) {
  const [days, setDays] = useState<WindowDays>(30);
  const [chosenResolution, setResolution] = useState<Resolution>("hourly");
  const [thresholds, setThresholds] = useState<Record<Resolution, number>>({
    hourly: SETTINGS.hourly.defaultThreshold,
    daily: SETTINGS.daily.defaultThreshold,
  });
  const [chosenReturns, setReturns] = useState<Returns>("raw");
  const benchmark = useBenchmark(initialBenchmark);
  // Seven days hold only about five daily closes, so that window is hourly only.
  const resolution: Resolution = days === 7 ? "hourly" : chosenResolution;
  const settings = SETTINGS[resolution];
  const threshold = thresholds[resolution];
  const isSelf = benchmark.active.symbol === stockSymbol;

  const analysis = useMemo(() => {
    // Every loaded row (90 days): the market model is fitted on these, whatever the window.
    const full = resolution === "hourly" ? hourly : daily;
    const rows = rowsSince(full, asOf - days * DAY_MS);
    const series = computeChanges(rows);
    const event = { thresholdPp: threshold, before: settings.eventBars, after: settings.eventBars };
    return { full, rows, series, event, raw: view(series.changes, eventStudy(rows, series.changes, event), settings, resolution, false) };
  }, [hourly, daily, asOf, days, resolution, settings, threshold]);

  const benchSeries = isSelf ? null : benchmark.series;
  const closesByT = useMemo(
    () => benchSeries && new Map((resolution === "hourly" ? benchSeries.hourly : benchSeries.daily).map((p) => [p.t, p.value])),
    [benchSeries, resolution],
  );
  const market = useMemo(
    () =>
      closesByT &&
      marketAdjustment({ full: analysis.full, rows: analysis.rows, changes: analysis.series.changes, closesByT, event: analysis.event, resolution }),
    [analysis, closesByT, resolution],
  );
  const canAdjust = Boolean(market?.model && market.abnormal);
  // Only computed while shown: the resampling isn't free.
  const adjusted = useMemo(
    () =>
      chosenReturns === "adjusted" && market?.model && market.abnormal
        ? view(market.abnormal, market.studies.abnormal, settings, resolution, true)
        : null,
    [chosenReturns, market, settings, resolution],
  );

  const returns: Returns = adjusted ? chosenReturns : "raw";
  const shown = returns === "adjusted" ? adjusted! : analysis.raw;
  const adjustment: Adjustment | null =
    returns === "adjusted" && market?.model
      ? {
          benchmark: benchmark.active.symbol,
          model: market.model,
          eventModel: market.eventModel,
          missingBenchmark: market.missingBenchmark,
          days,
        }
      : null;
  const unavailable = isSelf
    ? `${stockSymbol} is the benchmark itself`
    : benchmark.status.state === "loading" && !benchmark.series
      ? "Loading the benchmark"
      : !benchmark.series
        ? "Benchmark prices aren’t available"
        : "Too few prices to estimate beta";

  function downloadCsv() {
    const csvBenchmark = closesByT && { symbol: benchmark.active.symbol, closesByT, model: market?.model ?? null };
    const blob = new Blob([researchCsv(analysis.rows, resolution, csvBenchmark)], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `eventlens_${stockSymbol}_${kalshiTicker}_${days}d_${resolution}_${new Date(asOf).toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  const { series } = analysis;
  const { changes, sameInterval } = shown;

  return (
    <div className="grid gap-4 sm:gap-5">
      <Card
        title="Research"
        subtitle={`Kalshi probability changes vs. ${stockSymbol} returns, compared only where both have a real observation`}
      >
        <div className="flex flex-col gap-3 sm:flex-row sm:flex-wrap sm:items-end">
          <Segmented
            label="Window"
            value={days}
            options={WINDOWS.map((d) => ({ value: d, label: `${d}D` }))}
            onChange={setDays}
          />
          <Segmented
            label="Resolution"
            value={resolution}
            options={[
              { value: "hourly" as const, label: "Hourly" },
              { value: "daily" as const, label: "Daily", disabled: days === 7, title: "Seven days hold only about five daily closes" },
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
              {THRESHOLDS.map((t) => (
                <option key={t} value={t}>
                  ≥ {t} pp in one {settings.noun[0]}
                </option>
              ))}
            </select>
          </label>
          <button
            type="button"
            onClick={downloadCsv}
            className="h-10 rounded-lg border border-border px-3 text-sm text-ink-secondary transition hover:bg-surface-raised hover:text-ink sm:ml-auto sm:h-8 sm:text-xs"
          >
            Download CSV
          </button>
        </div>

        <Summary
          changes={changes}
          excluded={series.excluded}
          stats={sameInterval}
          resolution={resolution}
          settings={settings}
          adjustment={adjustment}
          rawR={analysis.raw.sameInterval.r}
        />

        <PrimaryTest
          primary={market?.primary ?? null}
          unavailable={unavailable}
          benchmark={benchmark.active.symbol}
          stockSymbol={stockSymbol}
          settings={settings}
        />

        <p className="mt-3 text-xs text-ink-secondary">
          <span className="font-medium text-ink">How to read the sign.</span> Positive means {stockSymbol} tended to rise
          when the chance of YES rose; negative means it tended to fall. Here, YES = “{yesLabel}”. If YES is bad news for{" "}
          {stockSymbol}, negative values are what you’d expect.
        </p>
      </Card>

      <MarketAdjustmentCard
        stockSymbol={stockSymbol}
        benchmark={benchmark}
        isSelf={isSelf}
        market={market}
        raw={{ same: analysis.raw.sameInterval, study: analysis.raw.study! }}
        resolution={resolution}
        days={days}
        unit={settings.unit}
        same={settings.same}
        noun={settings.noun}
        yesLabel={yesLabel}
      />

      {changes.length === 0 ? (
        <Notice
          tone="info"
          title="Nothing to analyze in this window"
          message="No intervals have a usable Kalshi price and stock price at both ends. The CSV lists every row with the reason it was left out."
        />
      ) : (
        <>
          <div className="grid gap-4 sm:gap-5 lg:grid-cols-2">
            <LeadLagCard
              lags={shown.lags}
              adjustedBy={returns === "adjusted" ? benchmark.active.symbol : null}
              settings={settings}
              stockSymbol={stockSymbol}
              yesLabel={yesLabel}
              adjustment={adjustment}
              resolution={resolution}
            />
            <RollingCard
              points={shown.rolling}
              changes={changes.length}
              settings={settings}
              resolution={resolution}
              adjustment={adjustment}
            />
          </div>
          <EventStudyCard
            study={shown.study}
            tests={shown.events}
            settings={settings}
            stockSymbol={stockSymbol}
            threshold={threshold}
            yesLabel={yesLabel}
            adjustment={adjustment}
            resolution={resolution}
          />
        </>
      )}

      <p className="text-xs text-ink-muted">
        Correlation, not causation: these figures describe how the two series moved together in this sample. They are
        not predictions or trading signals. Other news can move both at once.
      </p>
    </div>
  );
}

// ---- Summary and flags ----

function sampleFlags(stats: CorrelationStats): string[] {
  const flags: string[] = [];
  if (stats.flag === "insufficient") flags.push(`Too few intervals to analyze (n = ${stats.n}; at least 10 needed)`);
  else if (stats.flag === "small") flags.push(`Small sample (n = ${stats.n}): results can swing a lot by chance`);
  if (stats.noVariation) flags.push("Kalshi's probability didn't change, so there's no correlation to measure");
  else if (stats.n > 0 && stats.fewKalshiMoves) flags.push(`Kalshi moved in only ${stats.kalshiMoves} intervals: a few moves decide the results`);
  return flags;
}

/** e.g. "beta 1.18 from the full 90 days (n = 412 hourly intervals), not only this window". */
function betaFrom(model: MarketModel, resolution: Resolution, days: number): string {
  return `beta ${model.beta.toFixed(2)} from ${modelSample(model, resolution)}${days < 90 ? ", not only this window" : ""}`;
}

/** The adjustment in one sentence, for a chart's small print. */
function adjustmentNote({ benchmark, model, days }: Adjustment, stockSymbol: string, resolution: Resolution): string {
  return `Market-adjusted: ${stockSymbol}’s return minus (alpha + beta × ${benchmark}’s return), with ${betaFrom(model, resolution, days)}.`;
}

function Summary({
  changes,
  excluded,
  stats,
  resolution,
  settings,
  adjustment,
  rawR,
}: {
  changes: ChangePoint[];
  excluded: ChangeSeries["excluded"];
  stats: CorrelationStats;
  resolution: Resolution;
  settings: Settings;
  adjustment: Adjustment | null;
  rawR: number | null;
}) {
  const intervalNoun: [string, string] = resolution === "hourly" ? ["hourly interval", "hourly intervals"] : ["daily interval", "daily intervals"];
  const range = changes.length > 0 ? ` (${formatShortDate(changes[0].t)} – ${formatShortDate(changes[changes.length - 1].t)})` : "";
  const left = Object.entries(excluded)
    .filter(([, n]) => n > 0)
    .map(([reason, n]) => `${n.toLocaleString("en-US")} ${EXCLUSION_LABEL[resolution][reason] ?? reason}`);
  if (adjustment && adjustment.missingBenchmark > 0) {
    left.push(`${adjustment.missingBenchmark.toLocaleString("en-US")} without a ${adjustment.benchmark} price at both ends`);
  }
  const flags = sampleFlags(stats);
  return (
    <div className="mt-4 text-sm text-ink-secondary">
      <p>
        <span className="font-semibold text-ink">{plural(changes.length, intervalNoun)}</span>
        {range}, Kalshi moved in {plural(stats.kalshiMoves, [settings.noun[0], settings.noun[1]])}.
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
          Market-adjusted returns use {betaFrom(adjustment.model, resolution, adjustment.days)}.
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
  unavailable,
  benchmark,
  stockSymbol,
  settings,
}: {
  primary: TestResult | null;
  /** Why market adjustment isn't available, when it isn't. */
  unavailable: string;
  benchmark: string;
  stockSymbol: string;
  settings: Settings;
}) {
  const missing = primary === null ? null : unavailableText(primary);
  return (
    <div className="mt-4 rounded-lg border border-border p-3">
      <div className="flex flex-wrap items-center gap-2">
        <RoleBadge role="primary" />
        <span className="text-sm font-medium text-ink">
          {settings.same} correlation of Kalshi changes with {stockSymbol}’s market-adjusted returns
          {primary && ` (vs. ${benchmark})`}
        </span>
      </div>
      {primary === null ? (
        <p className="mt-2 text-sm text-ink-secondary">
          No primary test: {unavailable.charAt(0).toLowerCase() + unavailable.slice(1)}, so there are no market-adjusted returns
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
          <p className="mt-1 text-xs text-ink-muted">
            {missing ?? methodText(primary)} This is the question the page is set up to answer, chosen before looking at the data,
            so it’s judged on its own p-value. Everything else on the page is exploratory: corrected for the other tests in its
            chart, and best treated as leads to check, not findings. Switching window, resolution, or benchmark until something
            looks significant isn’t corrected for.
          </p>
        </>
      )}
    </div>
  );
}

// ---- Chart cards ----

function when(lag: number, settings: Settings, subject: string): string {
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
  yesLabel,
  adjustment,
  resolution,
}: {
  lags: LagCorrelation[];
  /** The benchmark when lag 0 is the primary test (market-adjusted returns), else null. */
  adjustedBy: string | null;
  settings: Settings;
  stockSymbol: string;
  yesLabel: string;
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
        {fmt(top)}, Kalshi changes tended to move {top.r! > 0 ? "in the same direction as" : "opposite to"}{" "}
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
    <Card title="Lead-lag" subtitle={`Correlation of Kalshi changes with ${stockSymbol} ${returnNoun}s, shifted by ${settings.noun[1]}`}>
      {measured.length === 0 ? (
        <Notice tone="info" title="Not enough data" message="Each lag needs at least 10 matching intervals, with some movement in both series." />
      ) : (
        <LeadLagChart lags={lags} unit={settings.unit} />
      )}
      <Caption
        lead={lead}
        caveats={
          <>
            Right of 0: Kalshi moved first. Left of 0: {stockSymbol} moved first. Whiskers are 95% intervals; one that reaches
            ±1 means Kalshi’s moves at that lag fall in too few {resolution === "hourly" ? "sessions" : "runs of days"} to pin the
            correlation down.{" "}
            <strong className="font-medium text-ink-secondary">
              Exploratory: corrected as one family, {familyText("lead_lag", family.length)}
              {adjustedBy && " (lag 0 is the primary test, judged on its own)"}.
            </strong>{" "}
            Holm keeps the chance of any false positive among them at 5%; Benjamini–Hochberg (BH) keeps the expected share of
            false positives among those that pass at 5%. Neighboring lags share most of their data, which makes Holm cautious.{" "}
            {withMethod && withMethod.test.p !== null && methodText(withMethod.test)} Kalshi’s changes are left as observed, zeros
            and all. The sign depends on what YES means (“{yesLabel}”).
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
}: {
  points: RollingPoint[];
  changes: number;
  settings: Settings;
  resolution: Resolution;
  adjustment: Adjustment | null;
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
            {points.some((p) => p.r === null) && " Gaps: one series didn't move in that window."} The sign depends on what YES
            means (see above).
            {adjustment && ` Every window uses the same ${betaFrom(adjustment.model, resolution, adjustment.days)}.`}
          </>
        }
      />
    </Card>
  );
}

/** Warnings for a group with few events: none, too few for any test, or rough intervals. */
function eventFlag(name: string, group: GroupTests | undefined, n: number): string | null {
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
  yesLabel,
  adjustment,
  resolution,
}: {
  study: EventStudy | null;
  tests: EventStudyTests | null;
  settings: Settings;
  stockSymbol: string;
  threshold: number;
  yesLabel: string;
  adjustment: Adjustment | null;
  resolution: Resolution;
}) {
  const kind = adjustment ? "market-adjusted return" : "return";
  const card = (children: ReactNode) => (
    <Card
      title="Around Kalshi jumps"
      subtitle={`Average ${stockSymbol} cumulative ${kind} in the ${settings.noun[1]} before and after the probability moved ≥${threshold} pp in one ${settings.noun[0]}`}
    >
      {children}
    </Card>
  );
  if (study === null || tests === null) {
    return card(
      <Notice
        tone="info"
        title="Not enough data for a market-adjusted event study"
        message={`Fewer than 10 ${resolution} intervals in the last 90 days fall outside the jump windows, so beta can’t be estimated without the jumps shaping it. Try a larger jump size, or Raw.`}
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
  const barCount = [...tests.rises.bars, ...tests.falls.bars].filter((t) => t !== null && t.p !== null).length;
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
        thresholdPp={threshold}
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
            <strong className="font-medium text-ink-secondary">
              Exploratory. Bars are corrected as one family, {familyText("event_horizons", barCount)}; the two whole-path tests as
              another.
            </strong>{" "}
            Shaded: 95% intervals for the average path. Filled dots: bars whose BH-adjusted p is below 5%. Each bar’s test asks
            whether the paths after jumps differ from the baseline; the whole-path test asks whether they differ anywhere in the
            window (the largest deviation, judged against how large it gets by chance).{" "}
            {method && methodText(method)} A jump’s own volatility counts against it, so a stock that’s merely jumpier around news
            doesn’t pass. Based on {plural(study.rises.n, ["rise", "rises"])} and {plural(study.falls.n, ["fall", "falls"])} in the
            chance of YES (“{yesLabel}”). Paths start at the close before the jump (bar −1); the shaded bar is the{" "}
            {settings.noun[0]} the jump happened in. {settings.barNote}
            {skipped > 0 &&
              ` ${plural(skipped, ["jump was", "jumps were"])} skipped (within ${settings.eventBars} bars of an earlier jump, or too close to the edge of the data${
                study.skippedMissing > 0 && adjustment ? `, or missing a ${adjustment.benchmark} price` : ""
              }).`}
            {adjustment?.eventModel &&
              ` Market-adjusted with beta ${adjustment.eventModel.beta.toFixed(2)} and alpha from ${modelSample(adjustment.eventModel, resolution)} outside every jump window, so the jumps don’t shape beta; the baseline is adjusted the same way.`}
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
