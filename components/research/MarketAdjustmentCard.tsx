"use client";

import { useId, useState, type KeyboardEvent, type ReactNode } from "react";
import {
  correlationStats,
  type ChangePoint,
  type CorrelationStats,
  type EventStudy,
  type MarketAdjustment,
  type MarketModel,
  type Resolution,
} from "@/lib/analytics";
import { formatSigned } from "@/lib/format";
import { validateSearchQuery } from "@/lib/search/api";
import { validateStockTicker } from "@/lib/validation";
import { formatLag, type LagUnit } from "../charts/LeadLagChart";
import { StockSearch } from "../search/StockSearch";
import { cachedStockResults, unlistedTickerMatch } from "../search/StockSearchFetch";
import { Card, Notice, Stat } from "../ui";
import { Caption, Flag, fmtR, plural, Table } from "./parts";
import type { Benchmark, BenchmarkChoice } from "./useBenchmark";

/** At or above this R², the benchmark explains nearly all of the stock's moves. */
const NEAR_DUPLICATE_R2 = 0.95;

const intervalNoun = (resolution: Resolution): [string, string] =>
  resolution === "hourly" ? ["hourly interval", "hourly intervals"] : ["daily interval", "daily intervals"];

/** Where a market model comes from, e.g. "the full 90 days (n = 412 hourly intervals)". */
export function modelSample(model: MarketModel, resolution: Resolution): string {
  return `the full 90 days (n = ${plural(model.n, intervalNoun(resolution))})`;
}

/** Alpha per interval in percent; hourly alphas are tiny, so they get more decimals. */
const formatAlpha = (alpha: number) => formatSigned(alpha * 100, Math.abs(alpha * 100) >= 0.01 ? 3 : 4, "%");

const pairs = (changes: ChangePoint[]) => changes.map((c) => ({ x: c.probChangePp, y: c.logReturn }));
const lastValue = (mean: number[] | null | undefined) => formatSigned(mean?.at(-1) ?? null, 2, "%");

interface Props {
  stockSymbol: string;
  benchmark: Benchmark;
  /** The benchmark is the stock itself. */
  isSelf: boolean;
  market: MarketAdjustment | null;
  /** Raw results, to compare with. */
  raw: { same: CorrelationStats; study: EventStudy };
  resolution: Resolution;
  /** The selected window, in days. */
  days: number;
  unit: LagUnit;
  /** e.g. "Same-hour". */
  same: string;
  /** Singular and plural names of one interval, e.g. ["hour", "hours"]. */
  noun: [string, string];
  yesLabel: string;
}

/**
 * The benchmark, the market model behind the market-adjusted views, a comparison of raw,
 * beta-adjusted, and simple excess returns, and a regression of the stock on the benchmark
 * and Kalshi together.
 */
export function MarketAdjustmentCard({ stockSymbol, benchmark, isSelf, market, raw, resolution, days, unit, same, noun, yesLabel }: Props) {
  const bench = benchmark.active.symbol;
  const model = market?.model ?? null;
  const flags: string[] = [];
  if (isSelf) {
    flags.push(`${stockSymbol} is the benchmark itself, so its market-adjusted return is always zero. Pick a different benchmark.`);
  }
  if (model && model.r2 >= NEAR_DUPLICATE_R2) {
    flags.push(`${bench} explains almost all of ${stockSymbol}’s moves (R² = ${model.r2.toFixed(2)}): what’s left after adjusting is mostly noise`);
  }
  if (model?.flag === "small") flags.push(`Beta rests on only ${model.n} intervals, so it’s imprecise`);
  const overlap = market?.kalshiVsBenchmark;
  if (overlap && overlap.r !== null && overlap.band !== null && Math.abs(overlap.r) > overlap.band) {
    flags.push(
      `Kalshi changes moved with ${bench}’s returns (r = ${fmtR(overlap.r)}, n = ${overlap.n}): adjusting for ${bench} removes part of what this market tracks`,
    );
  }

  return (
    <Card title="Market adjustment" subtitle={`${stockSymbol}’s return net of what a benchmark explains, so market-wide moves don’t pass for a link with Kalshi`}>
      <BenchmarkField benchmark={benchmark} stockSymbol={stockSymbol} />

      {flags.length > 0 && (
        <div className="mt-3 flex flex-wrap gap-2">
          {flags.map((f) => (
            <Flag key={f}>{f}</Flag>
          ))}
        </div>
      )}

      {market && !model && (
        <div className="mt-4">
          <Notice
            tone="info"
            title="Not enough data to estimate beta"
            message={`Fewer than 10 ${intervalNoun(resolution)[1]} in the last 90 days have prices for both ${stockSymbol} and ${bench}.`}
          />
        </div>
      )}

      {market && model && (
        <>
          <ModelStats model={model} stockSymbol={stockSymbol} bench={bench} resolution={resolution} days={days} noun={noun} />
          <Comparison market={market} raw={raw} stockSymbol={stockSymbol} bench={bench} resolution={resolution} unit={unit} same={same} />
          <KalshiRegressionNote market={market} stockSymbol={stockSymbol} bench={bench} resolution={resolution} noun={noun} />
        </>
      )}

      <p className="mt-4 text-xs text-ink-muted">
        If this market’s event moves the whole market (an index level, the Fed, a recession), adjusting for {bench} also
        removes the part of the move {stockSymbol} shares with the market, which may be the very effect being studied: what’s
        left is how {stockSymbol} moved differently from {bench}. A benchmark that holds {stockSymbol} (as broad and sector ETFs
        often do) also absorbs part of its own move.{resolution === "hourly" && " Hourly beta uses trading hours only; daily beta includes overnight moves."}{" "}
        The sign depends on what YES means (“{yesLabel}”). Trying several windows, resolutions, or benchmarks raises the odds
        that one result looks significant by chance.
      </p>
    </Card>
  );
}

/** StockSearch, as on the form, picking the benchmark: a picked result applies at once, typed text with Enter or Apply. */
function BenchmarkField({ benchmark, stockSymbol }: { benchmark: Benchmark; stockSymbol: string }) {
  const labelId = useId();
  const [text, setText] = useState(benchmark.active.symbol);
  const [error, setError] = useState<string | null>(null);
  const { active, status, series } = benchmark;

  function apply(choice: BenchmarkChoice) {
    setError(null);
    benchmark.choose(choice, { skipLoad: choice.symbol === stockSymbol });
  }

  // Checked like the form's stock field, so a company name never spends credits on an error.
  function applyText() {
    const ticker = validateStockTicker(text);
    if (!ticker.ok) {
      return setError(text.trim() ? "Pick a stock or ETF from the list, or enter a ticker such as QQQ." : ticker.message);
    }
    const match = unlistedTickerMatch(text);
    if (match) {
      return setError(`No US stock or ETF has the ticker ${ticker.value}. Pick one from the list, such as ${match.symbol} (${match.name}).`);
    }
    const query = validateSearchQuery(text);
    const known = query.ok ? cachedStockResults(query.value)?.find((r) => r.symbol === ticker.value) : undefined;
    apply({ symbol: ticker.value, name: known?.name ?? null });
  }

  // StockSearch leaves Enter alone when nothing is highlighted; there's no form to submit, so apply the text.
  function onKeyDown(e: KeyboardEvent<HTMLDivElement>) {
    if (e.key !== "Enter" || e.defaultPrevented || e.nativeEvent.isComposing || !(e.target instanceof HTMLInputElement)) return;
    e.preventDefault();
    applyText();
  }

  let state: ReactNode;
  if (status.state === "loading") {
    state = <>Loading {status.choice.symbol}…</>;
  } else if (status.state === "error") {
    state = (
      <span className="text-down">
        Couldn’t load {status.choice.symbol}: {status.message}
        {series && status.choice.symbol !== active.symbol && ` Still using ${active.symbol}.`}{" "}
        <button type="button" onClick={() => apply(status.choice)} className="underline hover:text-ink">
          Try again
        </button>
      </span>
    );
  } else {
    state = (
      <>
        Using <span className="font-mono text-ink">{active.symbol}</span>
        {active.name && ` · ${active.name}`}
      </>
    );
  }

  return (
    <div role="group" aria-labelledby={labelId} className="max-w-md">
      <span id={labelId} className="mb-1.5 block text-xs font-medium text-ink-secondary">
        Benchmark
      </span>
      {/* StockSearch's own "Stock or ETF" label stays for screen readers; "Benchmark" names the group on screen. */}
      <div className="flex items-start gap-2" onKeyDown={onKeyDown}>
        <div className="min-w-0 flex-1 [&_label]:sr-only">
          <StockSearch
            value={text}
            onSelect={(ticker, result) => {
              setText(ticker);
              setError(null);
              if (result) apply({ symbol: result.symbol, name: result.name });
            }}
            invalid={error !== null}
          />
        </div>
        <button
          type="button"
          onClick={applyText}
          className="h-11 rounded-lg border border-border px-4 text-sm font-medium text-ink-secondary transition hover:bg-surface-raised hover:text-ink sm:h-10"
        >
          Apply
        </button>
      </div>
      {error ? (
        <p role="alert" className="mt-1.5 text-xs text-down">
          {error}
        </p>
      ) : (
        <p role="status" className="mt-1.5 text-xs text-ink-secondary">
          {state}
        </p>
      )}
    </div>
  );
}

function ModelStats({
  model,
  stockSymbol,
  bench,
  resolution,
  days,
  noun,
}: {
  model: MarketModel;
  stockSymbol: string;
  bench: string;
  resolution: Resolution;
  days: number;
  noun: [string, string];
}) {
  return (
    <div className="mt-5">
      <dl className="grid grid-cols-2 gap-x-6 gap-y-4 sm:grid-cols-4">
        <Stat
          label="Beta"
          value={model.beta.toFixed(2)}
          detail={model.betaCi ? `95% CI ${model.betaCi[0].toFixed(2)} to ${model.betaCi[1].toFixed(2)}` : undefined}
        />
        <Stat label="R²" value={model.r2.toFixed(2)} detail={`of ${stockSymbol}’s moves explained`} />
        <Stat label="Alpha" value={formatAlpha(model.alpha)} detail={`per ${noun[0]}`} />
        <Stat label="n" value={model.n.toLocaleString("en-US")} detail={`${intervalNoun(resolution)[1]}, 90 days`} />
      </dl>
      <p className="mt-3 text-xs text-ink-secondary">
        <span className="font-medium text-ink">Beta and alpha are estimated from the full 90 days</span>
        {days < 90 && <>, not only the selected {days}-day window</>}: {plural(model.n, intervalNoun(resolution))} where both{" "}
        {stockSymbol} and {bench} have prices (Kalshi isn’t needed). Market-adjusted return = {stockSymbol}’s return − (alpha +
        beta × {bench}’s return), all log returns over the same interval.
      </p>
    </div>
  );
}

function Comparison({
  market,
  raw,
  stockSymbol,
  bench,
  resolution,
  unit,
  same,
}: {
  market: MarketAdjustment;
  raw: Props["raw"];
  stockSymbol: string;
  bench: string;
  resolution: Resolution;
  unit: LagUnit;
  same: string;
}) {
  const abnormal = correlationStats(pairs(market.abnormal ?? []));
  const excess = correlationStats(pairs(market.excess));
  const end = formatLag(raw.study.offsets.at(-1)!, unit);
  const row = (label: string, stats: CorrelationStats, study: EventStudy | null) => [
    label,
    fmtR(stats.r),
    String(stats.n),
    lastValue(study?.rises.mean),
    lastValue(study?.falls.mean),
    lastValue(study?.baseline.mean),
  ];
  const { eventModel } = market;
  return (
    <div className="mt-5 text-xs">
      <p className="mb-2 text-sm font-medium text-ink">Raw vs. adjusted, this window</p>
      <Table
        head={["Returns", `${same} r`, "n", `After rises, ${end}`, `After falls, ${end}`, `Baseline, ${end}`]}
        rows={[
          row("Raw", raw.same, raw.study),
          row("Beta-adjusted", abnormal, market.studies.abnormal),
          row(`Simple excess (${stockSymbol} − ${bench})`, excess, market.studies.excess),
        ]}
      />
      <p className="mt-2 text-ink-muted">
        r: correlation of Kalshi changes with each kind of return. The last three columns are the event study’s average
        path by {end}. Simple excess subtracts {bench}’s return one for one (beta 1, no alpha).{" "}
        {eventModel
          ? `The event study’s beta-adjusted paths use a separate beta, ${eventModel.beta.toFixed(2)}, also from ${modelSample(eventModel, resolution)} but leaving out every jump window, so the jumps don’t shape it.`
          : "Too few intervals fall outside the jump windows to estimate the event study’s beta, so its beta-adjusted paths are missing."}
        {market.missingBenchmark > 0 &&
          ` ${plural(market.missingBenchmark, ["interval has", "intervals have"])} no ${bench} price at both ends and ${market.missingBenchmark === 1 ? "is" : "are"} left out of the adjusted rows.`}
      </p>
    </div>
  );
}

function KalshiRegressionNote({
  market,
  stockSymbol,
  bench,
  resolution,
  noun,
}: {
  market: MarketAdjustment;
  stockSymbol: string;
  bench: string;
  resolution: Resolution;
  noun: [string, string];
}) {
  const fit = market.kalshi;
  let lead: ReactNode;
  let caveats: ReactNode = null;
  if (fit === null) {
    lead = "Not enough intervals with Kalshi movement to fit the regression (at least 10 intervals with some Kalshi movement are needed).";
  } else {
    const pct = (v: number) => formatSigned(v, 3, "%");
    const showP = !fit.fewKalshiMoves && fit.p !== null;
    lead = (
      <>
        With {bench}’s return held fixed, each 1 pp rise in the chance of YES went with a{" "}
        <span className="font-semibold text-ink">{pct(fit.coef)}</span> {stockSymbol} return in the same {noun[0]}
        {fit.ci && ` (95% CI ${pct(fit.ci[0])} to ${pct(fit.ci[1])})`}.{" "}
        {showP
          ? `p = ${fit.p! < 0.001 ? "< 0.001" : fit.p!.toFixed(3)}: ${fit.p! < 0.05 ? "distinguishable" : "not distinguishable"} from zero at the 5% level.`
          : fit.fewKalshiMoves
            ? `Kalshi moved in only ${plural(fit.kalshiMoves, noun)}, too few to judge whether this differs from zero.`
            : "Its standard error can’t be estimated: a single interval decides it."}
      </>
    );
    caveats = (
      <>
        Regression of {stockSymbol}’s return on {bench}’s return and the Kalshi change over this window’s{" "}
        {plural(fit.n, ["interval", "intervals"])} (Kalshi moved in {fit.kalshiMoves}); {bench}’s coefficient here is{" "}
        {fit.marketCoef.toFixed(2)}. Newey–West standard errors with {plural(fit.lags, ["lag", "lags"])} (no lag reaches
        across {resolution === "hourly" ? "a night or weekend" : "a missing session"}) and an HC3-style leverage
        correction: they allow for volatility that changes with news, for moves that carry over into the next {noun[0]},
        and for {noun[1]} without a Kalshi move, which let a few large moves carry the estimate. This describes how the
        two moved together, not cause and effect.
      </>
    );
  }
  return (
    <div className="mt-5">
      <p className="text-sm font-medium text-ink">Kalshi, with the market held fixed</p>
      <Caption lead={lead} caveats={caveats} />
    </div>
  );
}
