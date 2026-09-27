import type { KalshiOverview } from "@/lib/kalshi";
import { formatCents, formatCompact, formatProbability, formatSigned } from "@/lib/format";
import { Card, Delta, Stat } from "./ui";

const SOURCE_LABEL = {
  midpoint: "Midpoint of YES bid and ask",
  last_price: "Last trade (order book one-sided)",
  unavailable: "No quotes or trades available",
} as const;

function uncertaintyLabel(score: number): string {
  if (score >= 80) return "High — close to a coin flip";
  if (score >= 40) return "Moderate";
  return "Low — market leans strongly one way";
}

export function KalshiPanel({ data }: { data: KalshiOverview }) {
  const { market } = data;
  return (
    <Card
      title={
        <span className="flex items-center gap-2">
          <span aria-hidden className="h-2.5 w-2.5 rounded-full bg-series-kalshi" />
          Kalshi · <span className="font-mono">{market.ticker}</span>
        </span>
      }
      subtitle={`Status: ${market.status}${market.closeTime ? ` · Closes ${new Date(market.closeTime).toLocaleDateString("en-US", { dateStyle: "medium" })}` : ""}`}
    >
      <p className="text-base font-medium leading-snug text-ink">{market.title}</p>
      {market.subtitle && <p className="mt-1 text-sm text-ink-secondary">YES = {market.subtitle}</p>}

      <dl className="mt-5 grid grid-cols-2 gap-x-6 gap-y-5 sm:grid-cols-3">
        <div className="col-span-2 sm:col-span-3">
          <Stat
            size="lg"
            label="Implied probability"
            value={formatProbability(data.probability)}
            detail={SOURCE_LABEL[data.probabilitySource]}
          />
        </div>
        <Stat label="YES bid" value={formatCents(market.yesBid)} />
        <Stat label="YES ask" value={formatCents(market.yesAsk)} />
        <Stat label="Last price" value={formatCents(market.lastPrice)} />
        <Stat label="1h change" value={<Delta value={data.change1hPp} formatted={formatSigned(data.change1hPp, 1, " pp")} />} />
        <Stat label="24h change" value={<Delta value={data.change24hPp} formatted={formatSigned(data.change24hPp, 1, " pp")} />} />
        <Stat
          label="Uncertainty"
          value={data.uncertainty === null ? "—" : `${data.uncertainty.toFixed(0)} / 100`}
          detail={data.uncertainty === null ? undefined : uncertaintyLabel(data.uncertainty)}
        />
        <Stat label="24h volume" value={formatCompact(market.volume24h)} detail="contracts" />
        <Stat label="Open interest" value={formatCompact(market.openInterest)} detail="contracts" />
      </dl>
    </Card>
  );
}
