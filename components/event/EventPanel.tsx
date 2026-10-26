import { MAPPED_BY_TEXT } from "@/lib/expected/mapping";
import type { EventAnalysis, EventOutcome, ExpectedChange } from "@/lib/expected/types";
import { formatCents, formatDateTime, formatProbability } from "@/lib/format";
import { Card, Delta, Notice, Stat } from "../ui";
import { definitionText, formatExpected, MISSING_TEXT, RULE_TEXT, unmappedText } from "./text";

const CHANGE_NOTE: Record<NonNullable<ExpectedChange["unavailable"]>, string> = {
  no_current: "No current value",
  no_reference: "No value then",
  outcome_set_changed: "Open outcomes changed since",
};

export function EventTitle({ ticker }: { ticker: string }) {
  return (
    <span className="flex items-center gap-2">
      <span aria-hidden className="h-2.5 w-2.5 rounded-full bg-series-kalshi" />
      Kalshi event · <span className="font-mono">{ticker}</span>
    </span>
  );
}

function ChangeStat({ label, change, unit, live, frozen }: { label: string; change: ExpectedChange; unit: string; live: boolean; frozen: boolean }) {
  const detail = !live ? (
    frozen ? "Not live: frozen at the link’s as-of time" : "Not live: the event has closed"
  ) : change.unavailable ? (
    <>
      {CHANGE_NOTE[change.unavailable]}
      {change.from !== null && change.unavailable !== "no_current" && ` (${formatDateTime(change.from)})`}
    </>
  ) : (
    `vs. ${formatDateTime(change.from!)}`
  );
  return <Stat label={label} value={<Delta value={change.value} formatted={formatExpected(change.value, unit, 2)} />} detail={detail} />;
}

function Headline({ event }: { event: EventAnalysis }) {
  const live = event.phase === "open" && event.window.end === null;
  const { current } = event;
  const label = event.label.charAt(0).toUpperCase() + event.label.slice(1);
  if (current === null) {
    return <Stat size="lg" label={label} value="—" detail="No value before the close" />;
  }
  const detail =
    current.value === null
      ? `Missing: ${MISSING_TEXT[current.missing!]}`
      : live
        ? `From live books, ${formatDateTime(current.t)} · Σp ${current.sumP!.toFixed(3)}`
        : event.window.frozen
          ? `Last value by the link’s as-of time, ${formatDateTime(current.t, { withYear: true })} · Σp ${current.sumP!.toFixed(3)}`
          : `Last value before the close, ${formatDateTime(current.t, { withYear: true })} · Σp ${current.sumP!.toFixed(3)}`;
  return <Stat size="lg" label={label} value={formatExpected(current.value, event.unit, 1)} detail={detail} />;
}

/** The outcomes: what each is worth and how that was read, its probability and weight, and its book or result. */
function OutcomesTable({ event, live }: { event: EventAnalysis; live: boolean }) {
  const th = "whitespace-nowrap py-1 pr-3 font-medium";
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-left tabular-nums">
        <thead className="text-ink-muted">
          <tr>
            <th scope="col" className={th}>
              Outcome
            </th>
            <th scope="col" className={`${th} text-right`}>
              Value
            </th>
            <th scope="col" className={`${th} text-right`}>
              {live ? "p now" : event.window.frozen ? "p then" : "p at close"}
            </th>
            <th scope="col" className={`${th} text-right`}>
              Weight
            </th>
            <th scope="col" className={`${th} text-right`}>
              {live ? "Bid / ask" : "Result"}
            </th>
          </tr>
        </thead>
        <tbody className="text-ink-secondary">
          {event.outcomes.map((o) => (
            <OutcomeRow key={o.ticker} o={o} unit={event.unit} live={live} />
          ))}
        </tbody>
      </table>
    </div>
  );
}

function OutcomeRow({ o, unit, live }: { o: EventOutcome; unit: string; live: boolean }) {
  const read = o.mappedBy ? MAPPED_BY_TEXT[o.mappedBy] + (o.suffix === "irregular" ? "; irregular ticker suffix" : "") : "not mapped";
  return (
    <tr className="border-t border-border align-top">
      <td className="py-1.5 pr-3">
        <span className="block text-ink">{o.label}</span>
        <span className="block font-mono text-[11px] text-ink-muted">{o.ticker}</span>
        <span className="block text-[11px] text-ink-muted">{read}</span>
      </td>
      <td className="whitespace-nowrap py-1.5 pr-3 text-right">{o.value === null ? "—" : formatExpected(o.value, unit, 0)}</td>
      <td className="py-1.5 pr-3 text-right">
        <span className="block whitespace-nowrap">{o.p === null ? "—" : formatProbability(o.p, 1)}</span>
        {o.rule !== null && <span className="block text-[11px] text-ink-muted">{RULE_TEXT[o.rule]}</span>}
      </td>
      <td className="whitespace-nowrap py-1.5 pr-3 text-right">{o.weight === null ? "—" : formatProbability(o.weight, 1)}</td>
      <td className="whitespace-nowrap py-1.5 pr-3 text-right">
        {live ? `${formatCents(o.bid)} / ${formatCents(o.ask)}` : o.result ? o.result.toUpperCase() : "—"}
      </td>
    </tr>
  );
}

export function EventPanel({ event }: { event: EventAnalysis }) {
  const live = event.phase === "open" && event.window.end === null;
  const close =
    event.firstClose === null
      ? null
      : `${event.firstClose <= event.fetchedAt ? "First close" : "First outcome closes"} ${formatDateTime(event.firstClose, { withYear: true })}`;
  const unmapped = unmappedText(event);

  return (
    <Card title={<EventTitle ticker={event.ticker} />} subtitle={[`Status: ${event.phase.replace("_", " ")}`, close].filter(Boolean).join(" · ")}>
      <p className="text-base font-medium leading-snug text-ink">{event.title}</p>
      {event.subtitle && <p className="mt-1 text-sm text-ink-secondary">{event.subtitle}</p>}

      {unmapped && (
        <div className="mt-4">
          <Notice title={`No ${event.label} for this event`} message={unmapped} />
        </div>
      )}
      {event.decided && (
        <div className="mt-4">
          <Notice
            tone="info"
            title={`Event settled: ${event.decided.label}`}
            message="Trading has ended. The figures below are the last ones before the first outcome closed, not live quotes."
          />
        </div>
      )}
      {!event.decided && event.phase !== "open" && (
        <div className="mt-4">
          <Notice tone="info" title="Not trading" message="No outcome trades right now, so the figures below aren’t live." />
        </div>
      )}
      {event.window.frozen && (
        <div className="mt-4">
          <Notice
            tone="info"
            title="Frozen at the link’s as-of time"
            message={`The figures below are the event as of ${formatDateTime(event.window.end!, { withYear: true })}, not live quotes, so this link gives the same numbers later.`}
          />
        </div>
      )}
      {event.historyError && (
        <div className="mt-4">
          <Notice title="Kalshi history failed to load" message={`${event.historyError} E is missing where an outcome’s history is.`} />
        </div>
      )}

      <dl className="mt-5 grid grid-cols-2 gap-x-6 gap-y-5 sm:grid-cols-3">
        <div className="col-span-2 sm:col-span-3">
          <Headline event={event} />
        </div>
        <ChangeStat label="1h change" change={event.change1h} unit={event.unit} live={live} frozen={event.window.frozen === true} />
        <ChangeStat label="24h change" change={event.change24h} unit={event.unit} live={live} frozen={event.window.frozen === true} />
        <Stat
          label="Outcomes"
          value={String(event.outcomes.length)}
          detail={event.current?.openSet.length ? `${event.current.openSet.length} open${live ? "" : " at that time"}` : undefined}
        />
      </dl>

      <div className="mt-5 text-xs">
        <OutcomesTable event={event} live={live} />
      </div>
      <p className="mt-3 text-xs text-ink-muted">
        {definitionText(event)} Weight is p / Σp. Changes compare with the hourly value at or before 1 and 24 hours ago, across the
        same open outcomes.
      </p>
    </Card>
  );
}
