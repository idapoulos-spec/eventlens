"use client";

import type { ReactNode } from "react";
import { GLOSSARY } from "./glossary";
import { LEVEL_LABEL, METER_STEP, RATING_METHOD, type BottomLine, type BottomLineLevel, type BottomLineSection } from "./summary";
import { markTerms } from "./Term";

// The bottom line on the page: the analysis card at the top of Research, and the scan's version at the
// top of its results. It answers first (a question, a verdict, the finding, three tiles), folds the
// reasons away, and keeps the limits in view. Everything sits in one element marked data-plain-english
// (with no <section> inside it), which the markup pins leave out, so the cards below stay exactly as
// they were. The first use of each glossary term in a card is marked (<Term>): its definition shows on
// hover, focus, or a tap.

/**
 * The evidence badge's looks: an ink ramp with no hue, so no level reads as a go or a stop. Weight and
 * border style carry the level, and it's always written out. Every text here is at least 9.2:1 on the
 * card (README, "The bottom line").
 */
const BADGE: Record<Exclude<BottomLineLevel, "none">, string> = {
  strong: "bg-ink text-page",
  moderate: "bg-[var(--axis)] text-ink",
  weak: "border border-ink-muted text-ink-secondary",
  no_clear_link: "border border-border text-ink-secondary",
  nothing_stood_out: "border border-border text-ink-secondary",
  not_enough_data: "border border-dashed border-ink-muted text-ink-secondary",
  pending: "border border-dotted border-ink-muted text-ink-secondary",
};

/**
 * The rating, written out, in a live region so a screen reader hears "Checking…" turn into a rating.
 * The region stays mounted, and holds nothing for No rating.
 */
export function EvidenceBadge({ level }: { level: BottomLineLevel }) {
  return (
    <p role="status" className="shrink-0">
      {level !== "none" && (
        <span className={`inline-block whitespace-nowrap rounded-full px-2.5 py-0.5 text-xs font-semibold ${BADGE[level]}`}>
          <span className="sr-only">Evidence: </span>
          {LEVEL_LABEL[level]}
        </span>
      )}
    </p>
  );
}

/**
 * How strong the evidence is, as a meter of three steps (Weak, Moderate, Strong) in the correlation
 * charts' hue, its track a lighter step of the same hue: No clear link fills none; Not enough data
 * is hatched, since it's no reading at all. The level is always written beside it; the bar itself
 * is decoration.
 */
export function EvidenceMeter({ level }: { level: BottomLineLevel }) {
  if (level === "none") return null;
  const filled = METER_STEP[level];
  const unknown = level === "not_enough_data" || level === "pending";
  return (
    <div aria-hidden className="mt-1.5 flex w-full max-w-36 gap-0.5">
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
  );
}

/** The summary's texts with their terms marked, in reading order; the limits stay as written, unmarked. */
function marked(summary: BottomLine, method: boolean) {
  const shown = summary.sections.filter((s) => s.id !== "limits");
  const nodes = markTerms([summary.question, summary.headline, ...summary.tiles.map((t) => t.note), ...shown.flatMap((s) => s.items), ...(method ? RATING_METHOD : [])]);
  let at = 0;
  const take = (n: number) => nodes.slice(at, (at += n));
  const [question, headline] = take(2);
  const tiles = take(summary.tiles.length);
  const sections = new Map(shown.map((s) => [s.id, take(s.items.length)]));
  return { question, headline, tiles, sections, method: method ? take(RATING_METHOD.length) : null };
}

type Nodes = ReturnType<typeof marked>;

/** The question and the answer: its verdict in bold, then the plain finding. */
function Answer({ summary, nodes, size }: { summary: BottomLine; nodes: Nodes; size: string }) {
  return (
    <>
      <p className="mt-2 text-sm text-ink-secondary">{nodes.question}</p>
      <p className={`mt-2 ${size} text-ink`}>
        <strong className="font-semibold">{summary.verdict}</strong> {nodes.headline}
      </p>
    </>
  );
}

/** Three tiles side by side, wrapping by the card's own width, down to one column at 320 px. */
function Tiles({ summary, nodes, surface }: { summary: BottomLine; nodes: Nodes; surface: string }) {
  if (summary.tiles.length === 0) return null;
  return (
    <dl className="mt-4 flex flex-wrap gap-2">
      {summary.tiles.map((t, k) => (
        <div key={t.id} className={`min-w-0 flex-[1_1_10rem] rounded-lg border border-border p-3 ${surface}`}>
          <dt className="text-xs font-medium text-ink-secondary">{t.label}</dt>
          <dd className="mt-1 text-lg font-semibold leading-snug text-ink">
            {t.value}
            {t.id === "sure" && <EvidenceMeter level={summary.level} />}
          </dd>
          <dd className="mt-1.5 text-xs text-ink-secondary">{nodes.tiles[k]}</dd>
        </div>
      ))}
    </dl>
  );
}

function Reasons({ section, nodes, titled }: { section: BottomLineSection; nodes: ReactNode[]; titled: boolean }) {
  const small = (item: string) => item.startsWith("Main test:") || item.startsWith("It comes from");
  return (
    <div className="mt-3 first:mt-0">
      {titled && <h3 className="mb-1 text-xs font-semibold text-ink">{section.title}</h3>}
      {section.id === "trust" ? (
        <ul className="list-disc space-y-1 pl-5">
          {section.items.map((item, k) => (
            <li key={item}>{nodes[k]}</li>
          ))}
        </ul>
      ) : (
        section.items.map((item, k) => (
          <p key={item} className={`mt-1 first-of-type:mt-0 ${small(item) ? "text-xs" : ""}`}>
            {nodes[k]}
          </p>
        ))
      )}
    </div>
  );
}

const FOLD = "cursor-pointer py-1 text-sm text-ink-secondary hover:text-ink";

/** The folded parts: why it's rated what it is (the reasons, every caveat, and how the rating works), and the glossary. */
function Folds({ summary, nodes }: { summary: BottomLine; nodes: Nodes }) {
  const reasons = summary.sections.filter((s) => s.id !== "limits" && s.id !== "scan-lead");
  return (
    <div className="mt-4 grid gap-1 border-t border-border pt-3">
      {reasons.length > 0 && (
        <details>
          <summary className={FOLD}>{summary.why}</summary>
          <div className="mt-2 pb-2 text-sm text-ink-secondary">
            {reasons.map((s, k) => (
              <Reasons key={s.id} section={s} nodes={nodes.sections.get(s.id) ?? []} titled={k > 0} />
            ))}
            {nodes.method && (
              <div className="mt-3">
                <h3 className="mb-1 text-xs font-semibold text-ink">How the rating works</h3>
                <div className="space-y-1.5 text-xs">
                  {RATING_METHOD.map((p, k) => (
                    <p key={p}>{nodes.method![k]}</p>
                  ))}
                </div>
              </div>
            )}
          </div>
        </details>
      )}
      <details>
        <summary className={FOLD}>What the terms mean</summary>
        <dl className="mt-2 grid gap-1.5 pb-2 text-xs text-ink-secondary">
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

/** What this can't tell you, as written, and always in view. */
function Limits({ summary }: { summary: BottomLine }) {
  return <p className="mt-3 text-xs text-ink-secondary">{summary.sections.find((s) => s.id === "limits")!.items.join(" ")}</p>;
}

/** The analysis card at the top of Research. */
export function BottomLineCard({ summary }: { summary: BottomLine }) {
  const nodes = marked(summary, true);
  return (
    <section data-plain-english="" aria-label="The bottom line" className="min-w-0 rounded-xl border border-border bg-surface p-5 [overflow-wrap:anywhere]">
      <header className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
        <h2 className="text-sm font-semibold tracking-wide text-ink">The bottom line</h2>
        <EvidenceBadge level={summary.level} />
      </header>
      <Answer summary={summary} nodes={nodes} size="text-base" />
      <Tiles summary={summary} nodes={nodes} surface="bg-surface-raised" />
      <Folds summary={summary} nodes={nodes} />
      <Limits summary={summary} />
    </section>
  );
}

/** The scan's bottom line, at the top of its results card. Its badge rates the strongest lead, so it sits there. */
export function ScanBottomLine({ summary }: { summary: BottomLine }) {
  const nodes = marked(summary, false);
  const lead = summary.sections.find((s) => s.id === "scan-lead");
  const leadNodes = lead ? nodes.sections.get("scan-lead")! : [];
  return (
    <section data-plain-english="" aria-label="The bottom line" className="mb-4 rounded-lg border border-border bg-surface-raised p-4 [overflow-wrap:anywhere]">
      <h3 className="text-sm font-semibold tracking-wide text-ink">The bottom line</h3>
      <Answer summary={summary} nodes={nodes} size="text-sm" />
      <Tiles summary={summary} nodes={nodes} surface="bg-surface" />
      {lead && (
        <div className="mt-4">
          <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
            <h4 className="text-xs font-semibold text-ink">{lead.title}</h4>
            <EvidenceBadge level={summary.level} />
          </div>
          <p className="mt-1.5 text-sm text-ink">{leadNodes[0]}</p>
          <p className="mt-2 text-xs text-ink-secondary">{leadNodes[1]}</p>
        </div>
      )}
      <Folds summary={summary} nodes={nodes} />
      <Limits summary={summary} />
    </section>
  );
}
