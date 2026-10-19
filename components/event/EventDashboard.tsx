import { Suspense, type ReactNode } from "react";
import { alignSeries, expectedVariable } from "@/lib/analytics";
import { loadEventAnalysis } from "@/lib/expected/load";
import type { EventAnalysis } from "@/lib/expected/types";
import { formatDateTime } from "@/lib/format";
import { eventLongRows, eventResearchRows, lastRows, rowsOverlap, type LongRows } from "@/lib/history/rows";
import { provenanceNote, STOCK_HISTORY_MS } from "@/lib/history/window";
import type { LongMarks } from "@/lib/expected/load";
import { benchmarkFrom } from "@/lib/market-data/benchmark-series";
import type { StockAnalysis } from "@/lib/market-data";
import type { BenchmarkSeries } from "@/lib/market-data/types";
import { ok, type Result } from "@/lib/result";
import { RememberAnalysis } from "../analysis/RecentAnalyses";
import { ComparisonChart } from "../charts/ComparisonChart";
import { ResearchCard } from "../Research";
import { ResearchPanel } from "../research/ResearchPanel";
import { StockPanel } from "../StockPanel";
import { Card, Notice } from "../ui";
import { EventPanel, EventTitle } from "./EventPanel";
import { ExpectedHistoryChart } from "./ExpectedHistoryChart";
import { OutcomeWeightsChart } from "./OutcomeWeightsChart";
import { definitionText, MISSING_TEXT, unmappedText } from "./text";

type EventResult = Promise<Result<EventAnalysis>>;
type StockResult = Promise<Result<StockAnalysis>>;

const DAY_MS = 24 * 60 * 60 * 1000;
const upperFirst = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/**
 * A whole event against a stock: the event's expected value E now and over time, the outcome
 * probabilities behind it, and Research with ΔE as the Kalshi variable. Laid out like the
 * single-market Dashboard; each section waits only for the data it needs. Research and the stock's
 * history end at the event's first close once it has passed.
 */
export function EventDashboard({ stock, kalshi }: { stock: string; kalshi: string }) {
  const { event, stockData, benchmarkData, long } = loadEventAnalysis(stock, kalshi);

  return (
    <div className="grid gap-4 sm:gap-5">
      <div className="grid gap-4 sm:gap-5 lg:grid-cols-2">
        <Suspense fallback={<Loading title={<EventTitle ticker={kalshi} />} label="Loading Kalshi event" className="h-96" />}>
          <EventSummary data={event} ticker={kalshi} />
        </Suspense>
        <Suspense fallback={<Loading title={`Stock · ${stock}`} label="Loading stock data" className="h-96" />}>
          <StockSummary data={stockData} symbol={stock} />
        </Suspense>
      </div>

      <Suspense fallback={<Loading title="Expected value vs. stock" label="Loading 7-day comparison" className="h-80" />}>
        <Comparison eventData={event} stockData={stockData} stock={stock} />
      </Suspense>

      <div className="grid gap-4 sm:gap-5 lg:grid-cols-2">
        <Suspense fallback={<Loading title="Expected value over time" label="Loading history" className="h-64" />}>
          <History data={event} />
        </Suspense>
        <Suspense fallback={<Loading title="Outcome probabilities" label="Loading outcome probabilities" className="h-64" />}>
          <Weights data={event} />
        </Suspense>
      </div>

      <Suspense
        fallback={
          <ResearchCard>
            <Skeleton label="Loading research" className="h-72" />
          </ResearchCard>
        }
      >
        <EventResearch eventData={event} stockData={stockData} benchmarkData={benchmarkData} longData={long} stock={stock} kalshi={kalshi} />
      </Suspense>

      <Suspense fallback={null}>
        <SourcesNote eventData={event} stockData={stockData} />
      </Suspense>

      <Suspense fallback={null}>
        <RememberRecent eventData={event} stockData={stockData} kalshi={kalshi} stock={stock} />
      </Suspense>
    </div>
  );
}

// ---- Placeholders ----

function Skeleton({ label, className }: { label: string; className: string }) {
  return (
    <div role="status" className={`flex items-center justify-center rounded-lg bg-surface-raised/40 ${className}`}>
      <span className="text-xs text-ink-muted">{label}…</span>
    </div>
  );
}

function Loading({ title, label, className }: { title: ReactNode; label: string; className: string }) {
  return (
    <Card title={title}>
      <Skeleton label={label} className={className} />
    </Card>
  );
}

// ---- Sections ----

async function EventSummary({ data, ticker }: { data: EventResult; ticker: string }) {
  const e = await data;
  if (e.ok) return <EventPanel event={e.data} />;
  return (
    <Card title={<EventTitle ticker={ticker} />}>
      <Notice title="Kalshi event unavailable" message={e.error.message} />
    </Card>
  );
}

async function StockSummary({ data, symbol }: { data: StockResult; symbol: string }) {
  const s = await data;
  if (s.ok) return <StockPanel data={s.data} />;
  const missingKey = s.error.code === "missing_key";
  return (
    <Card title={`Stock · ${symbol}`}>
      <Notice
        tone={missingKey ? "info" : "error"}
        title={missingKey ? "Stock data not set up" : "Stock data unavailable"}
        message={s.error.message}
      />
    </Card>
  );
}

/** Why an event has no E to chart, or null if it has one. */
function noExpected(e: EventAnalysis): string | null {
  const unmapped = unmappedText(e);
  if (unmapped) return unmapped;
  if (!e.marks.some((m) => m.value !== null)) {
    const reasons = [...new Set(e.marks.map((m) => m.missing).filter((r) => r !== null))];
    return `E is missing at every hour in the window: ${reasons.map((r) => MISSING_TEXT[r!]).join("; ")}.`;
  }
  return null;
}

async function Comparison({ eventData, stockData, stock }: { eventData: EventResult; stockData: StockResult; stock: string }) {
  const [e, s] = await Promise.all([eventData, stockData]);
  const card = (subtitle: string, content: ReactNode) => (
    <Card title="Expected value vs. stock" subtitle={subtitle}>
      {content}
    </Card>
  );
  if (!e.ok || !s.ok) {
    return card(`vs. ${stock}`, <Notice tone="info" title="Comparison unavailable" message="The comparison needs data from both Kalshi and Twelve Data." />);
  }
  const event = e.data;
  const subtitle = `${event.ticker} vs. ${stock} · hourly, ${event.window.end === null ? "last 7 days" : "7 days before the first close"}`;
  const why = noExpected(event);
  if (why) return card(subtitle, <Notice tone="info" title="Comparison unavailable" message={why} />);

  const from = event.to - 7 * DAY_MS;
  const marks = event.marks.filter((m) => m.t >= from).map((m) => ({ t: m.t, value: m.value }));
  const bars = s.data.research.halfHourly.filter((b) => b.t >= from && b.t <= event.to).map((b) => ({ t: b.t, value: b.close }));
  const aligned = alignSeries(marks, bars, 1);
  if (aligned.length < 2) {
    return card(subtitle, <Notice tone="info" title="Comparison unavailable" message="E and the stock's prices don't overlap in this week." />);
  }
  return card(
    subtitle,
    <ComparisonChart
      points={aligned}
      stockSymbol={s.data.quote.symbol}
      currency={s.data.quote.currency}
      kalshi={{
        label: upperFirst(event.label),
        changeLabel: "ΔE since start",
        changeUnit: event.unit,
        levelSuffix: ` ${event.unit}`,
        levelUnit: event.unit,
        signed: true,
      }}
      note="E is hourly; each value holds until the next hour, and it's left blank where it's missing rather than carried over. The stock line is flat outside trading hours."
    />,
  );
}

async function History({ data }: { data: EventResult }) {
  const e = await data;
  const card = (content: ReactNode, subtitle?: string) => (
    <Card title="Expected value over time" subtitle={subtitle ?? "Hourly, up to 90 days"}>
      {content}
    </Card>
  );
  if (!e.ok) return card(<Notice title="History unavailable" message="The Kalshi event couldn't be loaded, so there's no history to show." />);
  const why = noExpected(e.data);
  if (why) return card(<Notice tone="info" title="No expected value" message={why} />);
  const label = upperFirst(e.data.label);
  return card(
    <ExpectedHistoryChart points={e.data.chart} to={e.data.to} unit={e.data.unit} label={label} />,
    `${label} (${e.data.unit}), hourly${e.data.window.end === null ? "" : `, to the first close (${formatDateTime(e.data.window.end, { withYear: true })})`}`,
  );
}

async function Weights({ data }: { data: EventResult }) {
  const e = await data;
  const card = (content: ReactNode) => (
    <Card title="Outcome probabilities" subtitle="Each outcome’s share of Σp: the weights behind E">
      {content}
    </Card>
  );
  if (!e.ok) return card(<Notice title="History unavailable" message="The Kalshi event couldn't be loaded, so there's no history to show." />);
  const why = noExpected(e.data);
  if (why) return card(<Notice tone="info" title="No expected value" message={why} />);
  const outcomes = e.data.outcomes.filter((o) => o.value !== null).map((o) => ({ ticker: o.ticker, label: o.label, value: o.value! }));
  return card(<OutcomeWeightsChart points={e.data.weights} outcomes={outcomes} to={e.data.to} unit={e.data.unit} />);
}

/**
 * Research with ΔE: rows at the stock's observations, each reading E at its own hour (see
 * buildExpectedRows), then the same panel as for one market.
 */
async function EventResearch({
  eventData,
  stockData,
  benchmarkData,
  longData,
  stock,
  kalshi,
}: {
  eventData: EventResult;
  stockData: StockResult;
  benchmarkData: Promise<Result<BenchmarkSeries> | null>;
  /** E over the longer windows: the panel gets its rows after the first render. */
  longData: Promise<Result<LongMarks | null>>;
  stock: string;
  kalshi: string;
}) {
  const [e, s, b] = await Promise.all([eventData, stockData, benchmarkData]);
  const end = s.ok ? s.data.research.end : null;
  const notice = (title: string, message: string, tone: "info" | "error" = "info") => (
    <ResearchCard end={end}>
      <Notice tone={tone} title={title} message={message} />
    </ResearchCard>
  );
  if (!e.ok || !s.ok) return notice("Research unavailable", "Research needs data from both Kalshi and Twelve Data.");
  const event = e.data;
  const why = noExpected(event);
  if (why) return notice("Research unavailable", why);

  const rows = eventResearchRows({ marks: event.marks, research: s.data.research, fetchedAt: s.data.historyFetchedAt });
  if (!rowsOverlap(rows)) {
    return notice("Research unavailable", "E and the stock's prices don't overlap while the event was trading.");
  }
  const { hourly, daily, asOf } = lastRows(rows);
  // The longer windows' rows, streamed to the panel once E over them is in.
  const side = { research: s.data.research, fetchedAt: s.data.historyFetchedAt };
  const long = longData.then((l): Result<LongRows | null> =>
    !l.ok ? l : l.data === null ? ok(null) : ok(eventLongRows({ marks: l.data.marks, start: l.data.start, ...side })),
  );

  return (
    <div className="grid gap-4 sm:gap-5">
      <ResearchPanel
        hourly={hourly}
        daily={daily}
        asOf={asOf}
        windowEnd={end}
        stockSymbol={s.data.quote.symbol || stock}
        kalshiTicker={kalshi}
        variable={expectedVariable(event)}
        initialBenchmark={b?.ok ? ok(benchmarkFrom(b.data, Math.min(s.data.research.longStart, asOf - STOCK_HISTORY_MS))) : b}
        long={long}
        opened={event.window.start}
      />
      <p className="text-xs text-ink-muted">{definitionText(event)} Each Research row reads E at its own hour; an interval whose open outcomes changed between its ends is left out.</p>
    </div>
  );
}

async function SourcesNote({ eventData, stockData }: { eventData: EventResult; stockData: StockResult }) {
  const [e, s] = await Promise.all([eventData, stockData]);
  const fetchedAt = e.ok ? e.data.fetchedAt : s.ok ? s.data.fetchedAt : null;
  const stored = e.ok ? provenanceNote(e.data.provenance) : null;
  return (
    <p className="text-xs text-ink-muted">
      Sources: Kalshi public market data, Twelve Data.
      {fetchedAt !== null && ` Fetched ${formatDateTime(fetchedAt)}.`}
      {stored !== null && ` ${stored}`} All times are New York time. Data may be delayed.
    </p>
  );
}

// A ticker that doesn't exist, or that the Twelve Data plan doesn't cover, isn't worth coming back to.
const UNUSABLE_TICKER = new Set(["not_found", "plan"]);

async function RememberRecent({ eventData, stockData, kalshi, stock }: { eventData: EventResult; stockData: StockResult; kalshi: string; stock: string }) {
  const [e, s] = await Promise.all([eventData, stockData]);
  if ((!e.ok && UNUSABLE_TICKER.has(e.error.code)) || (!s.ok && UNUSABLE_TICKER.has(s.error.code))) return null;
  return <RememberAnalysis stock={stock} kalshi={kalshi} title={e.ok ? e.data.title : null} />;
}
