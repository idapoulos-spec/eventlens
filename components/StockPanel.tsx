import type { StockOverview } from "@/lib/market-data";
import { formatCompact, formatCurrency, formatPercent, formatSigned } from "@/lib/format";
import { Card, Delta, Stat } from "./ui";

export function StockPanel({ data }: { data: StockOverview }) {
  const { quote } = data;
  const volumeVsAvg = data.relativeVolume === null ? undefined : `${data.relativeVolume.toFixed(0)}% of average`;

  return (
    <Card
      title={
        <span className="flex items-center gap-2">
          <span aria-hidden className="h-2.5 w-2.5 rounded-full bg-series-stock" />
          Stock · <span className="font-mono">{quote.symbol}</span>
        </span>
      }
      subtitle={`${quote.exchange} · ${quote.currency} · Market ${quote.isMarketOpen ? "open" : "closed"}`}
    >
      <p className="text-base font-medium leading-snug text-ink">{quote.name}</p>

      <dl className="mt-5 grid grid-cols-2 gap-x-6 gap-y-5 sm:grid-cols-3">
        <div className="col-span-2 sm:col-span-3">
          <Stat
            size="lg"
            label={quote.isMarketOpen ? "Current price" : "Last close"}
            value={formatCurrency(quote.price, quote.currency)}
            detail={
              <Delta
                value={quote.change}
                formatted={`${formatSigned(quote.change)} (${formatSigned(quote.percentChange, 2, "%")}) today`}
              />
            }
          />
        </div>
        <Stat label="Previous close" value={formatCurrency(quote.previousClose, quote.currency)} />
        <Stat label="Volume" value={formatCompact(quote.volume)} detail={volumeVsAvg} />
        <Stat label="Avg volume" value={formatCompact(quote.averageVolume)} />
        <Stat label="Realized vol (30d)" value={formatPercent(data.realizedVol30d)} detail="Annualized, daily log returns" />
      </dl>
    </Card>
  );
}
