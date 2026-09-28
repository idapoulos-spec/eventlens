import type { ProbabilitySource } from "@/lib/analytics";
import type { ChangeUnavailable, KalshiChange, KalshiOverview, MarketPhase, PointSource } from "@/lib/kalshi";
import { formatCents, formatCompact, formatDateTime, formatProbability, formatSigned } from "@/lib/format";
import { Card, Delta, Notice, Stat } from "./ui";

const SOURCE_LABEL = {
  midpoint: "Midpoint of YES bid and ask",
  last_price: "Last trade (no two-sided quote)",
  unavailable: "No quotes or trades available",
} as const;

const METHOD_LABEL: Record<PointSource, string> = {
  midpoint: "midpoint",
  last_price: "last trade",
};

const CHANGE_NOTE: Record<ChangeUnavailable, string> = {
  market_not_live: "Market not trading",
  no_probability: "No current probability",
  history_failed: "History failed to load",
  not_enough_history: "Not enough history",
};

const NOT_LIVE_NOTE: Record<Exclude<MarketPhase, "open">, string> = {
  settled: "Not scored: market settled",
  closed: "Not scored: trading closed",
  not_trading: "Not scored: market not trading",
};

function uncertaintyLabel(score: number): string {
  if (score >= 80) return "High — close to a coin flip";
  if (score >= 40) return "Moderate";
  return "Low — market leans strongly one way";
}

function resultLabel(result: string | null): string {
  return result ? result.toUpperCase() : "Settled";
}

/** How long ago something happened, e.g. "5 minutes ago" or "27 days ago". */
function formatAge(ms: number): string {
  const plural = (n: number, unit: string) => `${n} ${unit}${n === 1 ? "" : "s"} ago`;
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 1) return "less than a minute ago";
  if (minutes < 60) return plural(minutes, "minute");
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return plural(hours, "hour");
  return plural(Math.floor(hours / 24), "day");
}

/** Set when the change compares probabilities estimated in different ways. */
function methodNote(current: ProbabilitySource, then: PointSource | null): string | null {
  if (current === "unavailable" || then === null || current === then) return null;
  return `Methods differ: ${METHOD_LABEL[current]} now, ${METHOD_LABEL[then]} then`;
}

function ChangeStat({ label, change, source }: { label: string; change: KalshiChange; source: ProbabilitySource }) {
  const note = methodNote(source, change.fromSource);
  const detail =
    change.from !== null ? (
      <>
        vs. {formatDateTime(change.from)}
        {note && <span className="mt-0.5 block font-medium text-warn">{note}</span>}
      </>
    ) : change.unavailable ? (
      CHANGE_NOTE[change.unavailable]
    ) : undefined;
  return <Stat label={label} value={<Delta value={change.pp} formatted={formatSigned(change.pp, 1, " pp")} />} detail={detail} />;
}

/** Flags a probability taken from the last trade, which may be long out of date, rather than live quotes. */
function LastTradeNotice({ price, tradedAt, asOf }: { price: number | null; tradedAt: number | null; asOf: number }) {
  const why = `There's no two-sided quote right now, so the probability is the last trade price (${formatCents(price)}), not the bid/ask midpoint.`;
  if (tradedAt === null) {
    return (
      <Notice
        tone="info"
        title="Probability is from the last trade, not live quotes"
        message={`${why} The time of that trade couldn't be loaded, so it may be out of date.`}
      />
    );
  }
  return (
    <Notice
      tone="info"
      title={`Probability is from a trade ${formatAge(asOf - tradedAt)}, not live quotes`}
      message={`${why} That trade was on ${formatDateTime(tradedAt, { withYear: true })}, so it may not reflect the market now.`}
    />
  );
}

/** Explains why a market that isn't trading shows no live probability. */
function PhaseBanner({ phase, result }: { phase: Exclude<MarketPhase, "open">; result: string | null }) {
  if (phase === "settled") {
    return (
      <Notice
        tone="info"
        title={result ? `Market settled: resolved ${resultLabel(result)}` : "Market settled"}
        message="Trading has ended. Prices below are the last ones before close, not live quotes, so no probability or uncertainty is shown."
      />
    );
  }
  if (phase === "closed") {
    return (
      <Notice
        tone="info"
        title="Trading closed: result pending"
        message="This market no longer trades and its result hasn't been published yet. Prices below are from before the close, not live quotes."
      />
    );
  }
  return (
    <Notice
      tone="info"
      title="Not currently trading"
      message="This market isn't open for trading, so it has no live quotes and no probability is shown."
    />
  );
}

function HeadlineStat({ data }: { data: KalshiOverview }) {
  if (data.phase === "settled") {
    return <Stat size="lg" label="Result" value={resultLabel(data.market.result)} detail="Final: this market has settled" />;
  }
  if (data.phase === "closed") {
    return <Stat size="lg" label="Result" value="Pending" detail="Trading has closed; awaiting the official result" />;
  }
  const detail =
    data.phase !== "open"
      ? "Market not trading"
      : data.probabilitySource === "last_price" && data.lastTradeAt !== null
        ? `Last trade, ${formatDateTime(data.lastTradeAt)} (no two-sided quote)`
        : SOURCE_LABEL[data.probabilitySource];
  return <Stat size="lg" label="Implied probability" value={formatProbability(data.probability)} detail={detail} />;
}

export function KalshiPanel({ data }: { data: KalshiOverview }) {
  const { market, phase } = data;
  const live = phase === "open";
  const closeDate = market.closeTime
    ? `${data.closePassed ? "Closed" : "Closes"} ${formatDateTime(Date.parse(market.closeTime), { withYear: true })}`
    : null;

  return (
    <Card
      title={
        <span className="flex items-center gap-2">
          <span aria-hidden className="h-2.5 w-2.5 rounded-full bg-series-kalshi" />
          Kalshi · <span className="font-mono">{market.ticker}</span>
        </span>
      }
      subtitle={[`Status: ${market.status}`, closeDate].filter(Boolean).join(" · ")}
    >
      <p className="text-base font-medium leading-snug text-ink">{market.title}</p>
      {market.subtitle && <p className="mt-1 text-sm text-ink-secondary">YES = {market.subtitle}</p>}
      {phase !== "open" && (
        <div className="mt-4">
          <PhaseBanner phase={phase} result={market.result} />
        </div>
      )}
      {live && data.probabilitySource === "last_price" && (
        <div className="mt-4">
          <LastTradeNotice price={data.probability} tradedAt={data.lastTradeAt} asOf={data.fetchedAt} />
        </div>
      )}

      <dl className="mt-5 grid grid-cols-2 gap-x-6 gap-y-5 sm:grid-cols-3">
        <div className="col-span-2 sm:col-span-3">
          <HeadlineStat data={data} />
        </div>
        <Stat label="YES bid" value={live ? formatCents(market.yesBid) : "—"} detail={live ? undefined : "No live quotes"} />
        <Stat label="YES ask" value={live ? formatCents(market.yesAsk) : "—"} detail={live ? undefined : "No live quotes"} />
        <Stat
          label="Last price"
          value={formatCents(market.lastPrice)}
          detail={
            phase === "settled" || phase === "closed"
              ? `Last trade before close${data.lastTradeAt === null ? "" : `, ${formatDateTime(data.lastTradeAt)}`}`
              : data.lastTradeAt === null
                ? undefined
                : `Traded ${formatDateTime(data.lastTradeAt)}`
          }
        />
        <ChangeStat label="1h change" change={data.change1h} source={data.probabilitySource} />
        <ChangeStat label="24h change" change={data.change24h} source={data.probabilitySource} />
        <Stat
          label="Uncertainty"
          value={data.uncertainty === null ? "—" : `${data.uncertainty.toFixed(0)} / 100`}
          detail={
            phase !== "open" ? NOT_LIVE_NOTE[phase] : data.uncertainty === null ? undefined : uncertaintyLabel(data.uncertainty)
          }
        />
        <Stat label="24h volume" value={formatCompact(market.volume24h)} detail="contracts" />
        <Stat label="Open interest" value={formatCompact(market.openInterest)} detail="contracts" />
      </dl>
    </Card>
  );
}
