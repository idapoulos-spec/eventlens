import { BADGE } from "./badge";
import { DECIDED_LABEL, SIGNAL_RULES_TITLE, SIGNAL_TITLE, type BottomLineSignal } from "./signal";

// The experimental signal inside the bottom-line card, in the spirit of a score card: the label and
// its evidence level, the reason, four chips, how it's decided, the full rules (folded), and the
// disclaimer, always in view. Ink only: no hue reads as a go or a stop, and it uses neither Kalshi's
// blue nor the stock's orange. A group, not a <section>, so the markup pins still leave the whole card
// out. Its words aren't marked as glossary terms, so every marker stays where it was.

const FOLD = "cursor-pointer py-1 text-sm text-ink-secondary hover:text-ink";

export function SignalPanel({ signal }: { signal: BottomLineSignal }) {
  const lean = signal.label === "buy" || signal.label === "sell";
  return (
    <div role="group" aria-label={SIGNAL_TITLE} className="mt-4 min-w-0 rounded-lg border border-border bg-surface-raised p-4">
      <h3 className="text-xs font-semibold tracking-wide text-ink-secondary">{SIGNAL_TITLE}</h3>
      {/* A live region, so a screen reader hears "Checking…" turn into the signal. */}
      <p role="status" className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1">
        <span className={`${lean ? "text-xl text-ink" : "text-lg text-ink-secondary"} font-semibold leading-snug`}>{signal.text}</span>
        {signal.levelText && (
          <>
            {" "}
            <span className="text-ink-secondary">·</span>{" "}
            <span className={`inline-block whitespace-nowrap rounded-full px-2.5 py-0.5 text-xs font-semibold ${signal.level === "none" ? "border border-border text-ink-secondary" : BADGE[signal.level]}`}>
              {signal.levelText}
            </span>
          </>
        )}
      </p>
      <p className="mt-1.5 text-sm text-ink">{signal.reason}</p>
      <ul className="mt-3 flex flex-wrap gap-2">
        {signal.chips.map((c) => (
          <li key={c.id} className="min-w-0 rounded-full border border-border bg-surface px-2.5 py-1 text-xs text-ink-secondary">
            {c.label}: <span className="font-semibold text-ink">{c.value}</span>
          </li>
        ))}
      </ul>
      <p className="mt-3 text-xs text-ink-secondary">
        <strong className="font-semibold text-ink">{DECIDED_LABEL}</strong> {signal.decided}
      </p>
      <details className="mt-2">
        <summary className={FOLD}>{SIGNAL_RULES_TITLE}</summary>
        <ul className="mt-1 list-disc space-y-1 pb-1 pl-5 text-xs text-ink-secondary">
          {signal.rules.map((r) => (
            <li key={r}>{r}</li>
          ))}
        </ul>
      </details>
      <p className="mt-2 text-xs text-ink-secondary">{signal.disclaimer}</p>
    </div>
  );
}
