"use client";

import type { ReactNode } from "react";
import { GLOSSARY } from "./glossary";
import { LEVEL_LABEL, METER_STEP, RATING_METHOD, type PlainLevel, type PlainSection, type PlainSummary } from "./summary";

// The plain-English summary on the page: the analysis card at the top of Research, and the scan's
// version at the top of its results. Everything sits in one element marked data-plain-english (with no
// <section> inside it), which the markup pins leave out, so the cards below stay exactly as they were.

/**
 * How strong the evidence is, as a meter of three steps (Weak, Moderate, Strong) in the correlation
 * charts' hue, its track a lighter step of the same hue: No clear link fills none; Not enough data
 * is hatched, since it's no reading at all. The level is always written beside it.
 */
export function EvidenceMeter({ level }: { level: PlainLevel }) {
  const label = LEVEL_LABEL[level];
  if (level === "none") return <p className="text-sm font-semibold text-ink">{label}</p>;
  const filled = METER_STEP[level];
  const unknown = level === "not_enough_data" || level === "pending";
  return (
    <div role="img" aria-label={`Evidence: ${label}`} className="flex items-center gap-3">
      <div aria-hidden className="flex w-36 gap-0.5">
        {[1, 2, 3].map((step) => (
          <span
            key={step}
            className={`h-2.5 flex-1 rounded-[2px] ${filled !== null && step <= filled ? "bg-series-correlation" : "bg-series-correlation/20"}`}
            style={
              unknown
                ? { backgroundImage: "repeating-linear-gradient(45deg, var(--ink-muted) 0 1.5px, transparent 1.5px 5px)", opacity: 0.6 }
                : undefined
            }
          />
        ))}
      </div>
      <span aria-hidden className="text-sm font-semibold text-ink">
        {label}
      </span>
    </div>
  );
}

function Section({ section, rated, level, render }: { section: PlainSection; rated: boolean; level: PlainLevel; render: (text: string) => ReactNode }) {
  const list = section.id === "trust";
  const [first, ...rest] = section.items;
  return (
    <div className="mt-4">
      <h3 className="text-xs font-medium uppercase tracking-wider text-ink-muted">{section.title}</h3>
      {rated && (
        <div className="mt-2">
          <EvidenceMeter level={level} />
        </div>
      )}
      {list ? (
        <ul className="mt-1.5 list-disc space-y-1 pl-5 text-sm text-ink-secondary">
          {section.items.map((item) => (
            <li key={item}>{render(item)}</li>
          ))}
        </ul>
      ) : (
        <>
          <p className="mt-1.5 text-sm text-ink-secondary">{render(first)}</p>
          {rest.map((item) => (
            <p key={item} className={`mt-1 ${item.startsWith("Main test:") || item.startsWith("It comes from") ? "text-xs text-ink-muted" : "text-sm text-ink-secondary"}`}>
              {render(item)}
            </p>
          ))}
        </>
      )}
    </div>
  );
}

/** The terms and how the rating works, folded away under the summary. */
export function PlainNotes({ method = true, render = (t: string) => t }: { method?: boolean; render?: (text: string) => ReactNode }) {
  return (
    <div className="mt-4 grid gap-2 border-t border-border pt-3 text-xs text-ink-secondary">
      {method && (
        <details>
          <summary className="cursor-pointer text-ink-secondary hover:text-ink">How the rating works</summary>
          <div className="mt-2 space-y-1.5">
            {RATING_METHOD.map((p) => (
              <p key={p}>{render(p)}</p>
            ))}
          </div>
        </details>
      )}
      <details>
        <summary className="cursor-pointer text-ink-secondary hover:text-ink">What the terms mean</summary>
        <dl className="mt-2 grid gap-1.5">
          {GLOSSARY.map((e) => (
            <div key={e.id}>
              <dt className="inline font-medium text-ink">{e.term}: </dt>
              <dd className="inline">{e.definition}</dd>
            </div>
          ))}
        </dl>
      </details>
    </div>
  );
}

/** The analysis card at the top of Research. */
export function PlainEnglishCard({ summary, render = (t: string) => t }: { summary: PlainSummary; render?: (text: string) => ReactNode }) {
  return (
    <section data-plain-english="" aria-label="In plain English" className="min-w-0 rounded-xl border border-border bg-surface p-5">
      <header className="mb-3">
        <h2 className="text-sm font-semibold tracking-wide text-ink">In plain English</h2>
        <p className="mt-1 text-xs text-ink-muted">What this analysis found, in everyday words, from the results below.</p>
      </header>
      <p className="text-base font-medium text-ink">{render(summary.headline)}</p>
      {summary.sections.map((s) => (
        <Section key={s.id} section={s} rated={s.id === "evidence" || s.id === "scan-lead"} level={summary.level} render={render} />
      ))}
      <PlainNotes render={render} />
    </section>
  );
}

/** The scan's summary, at the top of its results card. */
export function ScanPlainSummary({ summary, render = (t: string) => t }: { summary: PlainSummary; render?: (text: string) => ReactNode }) {
  return (
    <section data-plain-english="" aria-label="In plain English" className="mb-4 rounded-lg border border-border bg-surface-raised p-4">
      <h3 className="text-xs font-medium uppercase tracking-wider text-ink-muted">In plain English</h3>
      <p className="mt-1.5 text-sm font-medium text-ink">{render(summary.headline)}</p>
      {summary.sections.map((s) => (
        <Section key={s.id} section={s} rated={s.id === "scan-lead"} level={summary.level} render={render} />
      ))}
      <PlainNotes method={false} render={render} />
    </section>
  );
}
