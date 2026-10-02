"use client";

import { useMemo, useState, type ReactNode } from "react";
import {
  computeChanges,
  crossCorrelation,
  eventStudy,
  marketAdjustment,
  researchCsv,
  rollingCorrelation,
  rowsSince,
  type ChangePoint,
  type ChangeSeries,
  type CorrelationStats,
  type EventStudy,
  type LagCorrelation,
  type MarketModel,
  type Resolution,
  type ResearchRow,
  type RollingPoint,
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

function view(changes: ChangePoint[], study: EventStudy | null, settings: Settings): View {
  const lags = crossCorrelation(changes, settings.maxLag);
  return { changes, lags, sameInterval: lags.find((l) => l.lag === 0)!, rolling: rollingCorrelation(changes, settings.rollingWindow), study };
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
    return { full, rows, series, event, raw: view(series.changes, eventStudy(rows, series.changes, event), settings) };
  }, [hourly, daily, asOf, days, resolution, settings, threshold]);

  const benchSeries = isSelf ? null : benchmark.series;
  const closesByT = useMemo(
    () => benchSeries && new Map((resolution === "hourly" ? benchSeries.hourly : benchSeries.daily).map((p) => [p.t, p.value])),
    [benchSeries, resolution],
  );
  const market = useMemo(
    () =>
      closesByT &&
      marketAdjustment({ full: analysis.full, rows: analysis.rows, changes: analysis.series.changes, closesByT, event: analysis.event }),
    [analysis, closesByT],
  );
  const adjusted = useMemo(
    () => (market?.model && market.abnormal ? view(market.abnormal, market.studies.abnormal, settings) : null),
    [market, settings],
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
              { value: "adjusted" as const, label: "Market-adjusted", disabled: !adjusted, title: unavailable },
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

// ---- Chart cards ----

function when(lag: number, settings: Settings, subject: string): string {
  const n = Math.abs(lag);
  const span = plural(n, settings.noun);
  if (lag === 0) return `${subject} in the same ${settings.noun[0]}`;
  return lag > 0 ? `${subject} ${span} later` : `${subject} ${span} earlier`;
}

function LeadLagCard({
  lags,
  settings,
  stockSymbol,
  yesLabel,
  adjustment,
  resolution,
}: {
  lags: LagCorrelation[];
  settings: Settings;
  stockSymbol: string;
  yesLabel: string;
  adjustment: Adjustment | null;
  resolution: Resolution;
}) {
  const returnNoun = adjustment ? "market-adjusted return" : "return";
  const measured = lags.filter((l) => l.r !== null && l.band !== null);
  const largest = (ls: LagCorrelation[]) =>
    ls.reduce<LagCorrelation | null>((a, b) => (a === null || Math.abs(b.r!) > Math.abs(a.r!) ? b : a), null);
  // Each lag has its own number of pairs, so each is judged against its own range.
  const outside = measured.filter((l) => Math.abs(l.r!) > l.band!);
  const strongest = largest(outside);
  const chance = Math.round((1 - 0.95 ** lags.length) * 100);

  let lead: ReactNode;
  if (measured.length === 0) {
    lead = "Not enough matching intervals at any lag to measure a correlation.";
  } else if (strongest === null) {
    const top = largest(measured)!;
    lead = `No lag stands out: every bar is inside its dashed range, as expected with no relationship (largest: ${fmtR(top.r)} at ${formatLag(top.lag, settings.unit)}).`;
  } else {
    const others = outside.filter((l) => l !== strongest).map((l) => formatLag(l.lag, settings.unit));
    lead = `Outside its dashed range at ${formatLag(strongest.lag, settings.unit)}${
      others.length > 0 ? ` (also ${others.join(", ")})` : ""
    }: Kalshi changes tended to move ${strongest.r! > 0 ? "in the same direction as" : "opposite to"} ${when(
      strongest.lag,
      settings,
      `${stockSymbol}’s ${returnNoun}`,
    )} (r = ${fmtR(strongest.r)}, n = ${strongest.n}).`;
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
            Right of 0: Kalshi moved first. Left of 0: {stockSymbol} moved first. Dashed marks: each lag’s rough 95% range if
            there were no relationship (±1.96/√n for its number of pairs, assuming independent intervals).{" "}
            <strong className="font-medium text-ink-secondary">
              With {lags.length} lags tested, there’s about a {chance}% chance at least one crosses its range by chance
              alone.
            </strong>{" "}
            The sign depends on what YES means (“{yesLabel}”).
            {adjustment && ` ${adjustmentNote(adjustment, stockSymbol, resolution)}`}
          </>
        }
      />
      <ValuesTable
        head={["Lag", "r", "Pairs", "Range with no relationship"]}
        rows={lags.map((l) => [formatLag(l.lag, settings.unit), fmtR(l.r), String(l.n), l.band === null ? "—" : `±${l.band.toFixed(2)}`])}
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
  const band = 1.96 / Math.sqrt(w);
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
        <RollingCorrelationChart points={points} band={band} daily={resolution === "daily"} />
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
            ? `Shows whether the relationship held steady or came and went: it ranged from ${fmtR(Math.min(...rs))} to ${fmtR(Math.max(...rs))} (latest ${fmtR(latest)}).`
            : "Shows whether the relationship held steady or came and went over time."
        }
        caveats={
          <>
            Each point uses only {w} intervals, so values inside the dashed lines (±{band.toFixed(2)}) are within what chance
            alone produces. Neighboring points share most of their data.
            {points.some((p) => p.r === null) && " Gaps: one series didn't move in that window."} The sign depends on what YES
            means (see above).
            {adjustment && ` Every window uses the same ${betaFrom(adjustment.model, resolution, adjustment.days)}.`}
          </>
        }
      />
    </Card>
  );
}

function EventStudyCard({
  study,
  settings,
  stockSymbol,
  threshold,
  yesLabel,
  adjustment,
  resolution,
}: {
  study: EventStudy | null;
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
  if (study === null) {
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
  const few = study.rises.flag !== "ok" || study.falls.flag !== "ok";

  return card(
    <>
      <EventStudyChart
        study={study}
        unit={settings.unit}
        stockSymbol={adjustment ? `${stockSymbol} market-adjusted` : stockSymbol}
        thresholdPp={threshold}
      />
      <Caption
        lead={
          <>
            Compare each line with the dashed baseline (the stock’s normal drift over any window this long), not with zero.
            {parts.length > 0 && ` By ${end}, ${parts.join("; ")}, vs. ${at(study.baseline.mean)} for the baseline.`}
          </>
        }
        caveats={
          <>
            Based on {plural(study.rises.n, ["rise", "rises"])} and {plural(study.falls.n, ["fall", "falls"])} in the chance of
            YES (“{yesLabel}”){few ? ": too few to generalize, and one large move can dominate an average" : ""}. Paths start at
            the close before the jump (bar −1); the shaded bar is the {settings.noun[0]} the jump happened in. {settings.barNote}
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
        head={["Bar", "After rises", "After falls", "Baseline"]}
        rows={study.offsets.map((k, i) => [
          formatLag(k, settings.unit),
          formatSigned(study.rises.mean?.[i] ?? null, 2, "%"),
          formatSigned(study.falls.mean?.[i] ?? null, 2, "%"),
          formatSigned(study.baseline.mean?.[i] ?? null, 2, "%"),
        ])}
      />
    </>,
  );
}
