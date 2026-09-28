import type { ChangeUnavailable, KalshiChange, KalshiOverview, MarketPhase } from "@/lib/kalshi";
import { formatCents, formatCompact, formatDateTime, formatProbability, formatSigned } from "@/lib/format";
import { Card, Delta, Notice, Stat } from "./ui";

const SOURCE_LABEL = {
  midpoint: "Midpoint of YES bid and ask",
  last_price: "Last trade (no two-sided quote)",
  unavailable: "No quotes or trades available",
} as const;

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

function ChangeStat({ label, change }: { label: string; change: KalshiChange }) {
  const detail =
    change.from !== null ? `vs. ${formatDateTime(change.from)}` : change.unavailable ? CHANGE_NOTE[change.unavailable] : undefined;
  return <Stat label={label} value={<Delta value={change.pp} formatted={formatSigned(change.pp, 1, " pp")} />} detail={detail} />;
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
  return (
    <Stat
      size="lg"
      label="Implied probability"
      value={formatProbability(data.probability)}
      detail={data.phase === "open" ? SOURCE_LABEL[data.probabilitySource] : "Market not trading"}
    />
  );
}

export function KalshiPanel({ data }: { data: KalshiOverview }) {
  const { market, phase } = data;
  const live = phase === "open";
  const closeDate = market.closeTime
    ? `${data.closePassed ? "Closed" : "Closes"} ${new Date(market.closeTime).toLocaleDateString("en-US", { dateStyle: "medium" })}`
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

      <dl className="mt-5 grid grid-cols-2 gap-x-6 gap-y-5 sm:grid-cols-3">
        <div className="col-span-2 sm:col-span-3">
          <HeadlineStat data={data} />
        </div>
        <Stat label="YES bid" value={live ? formatCents(market.yesBid) : "—"} detail={live ? undefined : "No live quotes"} />
        <Stat label="YES ask" value={live ? formatCents(market.yesAsk) : "—"} detail={live ? undefined : "No live quotes"} />
        <Stat
          label="Last price"
          value={formatCents(market.lastPrice)}
          detail={phase === "settled" || phase === "closed" ? "Last trade before close" : undefined}
        />
        <ChangeStat label="1h change" change={data.change1h} />
        <ChangeStat label="24h change" change={data.change24h} />
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
