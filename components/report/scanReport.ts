// A finished scan's report, from exactly what its results card holds: the ranked table with both
// corrections, the exploratory-leads banner, the candidates that couldn't be tested, and where the
// data came from. Cells are the scan page's own (components/scan/ScanPage.tsx); report.test.ts
// compares them. No stock prices: only each candidate's statistics.

import { ALPHA } from "@/lib/analytics/inference";
import type { Resolution } from "@/lib/analytics/research";
import { SCAN_REFINE_BELOW, SCAN_REFINE_DRAWS } from "@/lib/analytics/scan";
import { formatDate } from "@/lib/format";
import type { Provenance } from "@/lib/history/types";
import { provenanceNote, WINDOW_LABEL, type WindowChoice } from "@/lib/history/window";
import { DEFAULT_BENCHMARK } from "@/lib/market-data/benchmark-series";
import type { Block, Report } from "@/lib/report/model";
import { reportInstant, reportTime } from "@/lib/report/format";
import type { ScanCandidate } from "@/lib/scan/types";
import { fmtR } from "../research/parts";
import { formatCi } from "../research/stats";
import type { CandidateState, ScanSnapshot } from "../scan/scanRunner";
import { chanceLine, correlationNote, medianAbs, SCOPE_NOTE, survivorsLine, WINNERS_CURSE } from "../scan/text";
import { caveatsSection, reproducibilitySection } from "./analysisReport";

/** p-values down to the finer p's resolution, as the scan page shows them (ScanPage's formatSmallP). */
export const formatSmallP = (p: number | null) => (p === null ? "—" : p >= 0.001 ? p.toFixed(3) : p.toExponential(1));

export interface ScanReportInput {
  stock: string;
  choice: WindowChoice;
  resolution: Resolution;
  candidates: ScanCandidate[];
  snap: ScanSnapshot;
  /** The scan's as-of time, or null for a live scan. */
  asOf: number | null;
  /** How the candidates were chosen, in words, e.g. "KXFEDDECISION’s open events, listed Oct 7, 2026, 12:40 PM EDT". */
  selection: string;
  /** The frozen link (absolute), or null when left out. */
  link: string | null;
  preparedBy: string | null;
  generatedAt: number;
  version: string;
  commit: string;
}

const p = (text: string): Block => ({ kind: "paragraph", text });
type Done = Extract<CandidateState, { status: "done" }>;

/** The candidate's details, as the table's second line shows them. */
export function candidateDetails(c: ScanCandidate, state: Done): string {
  return [
    c.kind === "event" ? "expected value" : c.label,
    c.picked ? (c.picked.open !== null ? `most-traded of ${c.picked.open} open (${c.picked.outcomes} in all)` : `most-traded of ${c.picked.outcomes}`) : null,
    c.end !== null ? `ended ${formatDate(c.end)}` : null,
    state.sameAs90 ? "same as 90D" : null,
  ]
    .filter(Boolean)
    .join(" · ");
}

/** The leave-one-out cell, as the table shows it. */
export function looText({ loo }: Done): string {
  if (loo === null || loo === "skipped") return "—";
  if (loo === "pending") return "running…";
  if (loo.flips > 0) return `flips in ${loo.flips} of ${loo.runs.length}`;
  return `stable${loo.p ? ` (p ${formatSmallP(loo.p[0])}–${formatSmallP(loo.p[1])})` : ""}`;
}

/** Each tested candidate's row, best first, as the scan's table shows them. */
export function scanRows(snap: ScanSnapshot, candidates: ScanCandidate[]): string[][] {
  return snap.order
    .filter((i) => snap.states[i].status === "done")
    .map((i, rank) => {
      const state = snap.states[i] as Done;
      const c = candidates[i];
      const corr = snap.corrections[i];
      const { primary, fragility } = state.test;
      const moves = fragility?.movement.effective ?? null;
      return [
        String(rank + 1),
        c.ticker,
        `${c.title}${candidateDetails(c, state) ? ` (${candidateDetails(c, state)})` : ""}`,
        `${fmtR(primary?.estimate ?? null)} (${formatCi(primary?.ci ?? null, fmtR)})`,
        formatSmallP(primary?.p ?? null),
        formatSmallP(state.test.p),
        formatSmallP(corr?.holm ?? null),
        formatSmallP(corr?.bh ?? null),
        corr?.survivesHolm ? "Holm and BH" : corr?.survivesBh ? "BH only" : "—",
        moves === null ? "—" : moves < 10 ? `${moves.toFixed(1)} (fragile)` : moves.toFixed(1),
        looText(state),
      ];
    });
}

export const SCAN_TABLE_HEAD = ["#", "Candidate", "Title", "r (95% CI)", "p (page)", "p (scan)", "Holm", "BH", "Survives", "F1 moves", "F3 leave-one-out"];

const provenanceText = (prov: Provenance | null) => (prov ? (provenanceNote(prov)?.replace("Kalshi research history ", "") ?? "live from Kalshi’s API") : "—");

export function scanReport(i: ScanReportInput): Report {
  const { snap, candidates, resolution } = i;
  const states = snap.states;
  const tested = states.flatMap((s, k) => (s.status === "done" ? [{ s, k }] : []));
  const untested = states.flatMap((s, k) => (s.status === "untested" ? [{ reason: s.reason, c: candidates[k] }] : []));
  const under = tested.filter(({ s }) => (s.test.primary?.p ?? 1) < ALPHA).length;
  const holm = snap.corrections.filter((c) => c?.survivesHolm).length;
  const bh = snap.corrections.filter((c) => c?.survivesBh).length;
  const median = medianAbs(tested.flatMap(({ s }) => (s.test.primary?.estimate == null ? [] : [s.test.primary.estimate])));
  const note = correlationNote(tested.map(({ k }) => candidates[k]));
  const unit = resolution === "hourly" ? "hour" : "day";
  const stored = candidates.filter((c) => c.stored).length;
  const ends =
    i.asOf !== null
      ? `Frozen as of ${reportInstant(i.asOf)}: each window ends there, or at its close if that came first.`
      : `Each window ends where its own page’s does: its close, or when the prices were fetched (${snap.prices ? reportTime(snap.prices.fetchedAt) : "—"}).`;

  return {
    title: `${i.stock} against ${candidates.length} Kalshi ${candidates.length === 1 ? "candidate" : "candidates"}`,
    kind: "EventLens scan report",
    preparedBy: i.preparedBy,
    sections: [
      {
        id: "question",
        title: "Question",
        blocks: [
          p(`Which of these ${candidates.length} Kalshi candidates moved with ${i.stock}’s market-adjusted returns (net of ${DEFAULT_BENCHMARK.symbol}) in the same ${unit}, over the ${WINDOW_LABEL[i.choice]} window?`),
          p("Each candidate gets the primary test its own page runs; Holm and Benjamini–Hochberg then correct across the whole scan. The results are exploratory leads, not findings."),
        ],
      },
      {
        id: "inputs",
        title: "Inputs",
        blocks: [
          {
            kind: "facts",
            rows: [
              ["Stock", i.stock],
              ["Candidates", `${candidates.length}: ${i.selection}`],
              ["Window", WINDOW_LABEL[i.choice]],
              ["Windows end", ends],
              ["Resolution", resolution === "hourly" ? "Hourly (trading hours, 10 AM–4 PM New York)" : "Daily (close to close)"],
              ["Returns", `Market-adjusted (vs. ${DEFAULT_BENCHMARK.symbol})`],
            ],
          },
          p("One test per candidate: a Fed decision event as its expected value; an event with one market as that market; any other event as its outcome with the highest lifetime volume (among its open outcomes while the event is open), picked from the listing before any stock data loaded."),
        ],
      },
      {
        id: "sources",
        title: "Data sources",
        blocks: [
          {
            kind: "facts",
            rows: [
              ["Kalshi", `Public market data: ${stored} of ${candidates.length} candidates read from EventLens’s data store first, the rest live (per candidate below).`],
              [
                "Twelve Data",
                snap.prices
                  ? `${i.stock}’s bars fetched ${reportTime(snap.prices.fetchedAt)}; ${DEFAULT_BENCHMARK.symbol}’s ${reportTime(snap.prices.benchmarkFetchedAt)}; ${snap.prices.requests} ${snap.prices.requests === 1 ? "request" : "requests"} for this scan.`
                  : "—",
              ],
            ],
          },
          {
            kind: "table",
            id: "scan-sources",
            head: ["Candidate", "Kalshi history"],
            rows: candidates.map((c, k) => [c.ticker, provenanceText(snap.provenance[k] ?? null)]),
          },
          p("Stock and benchmark prices are left out of this report under Twelve Data’s terms; only statistics computed from them are shown. All times are New York time."),
        ],
      },
      {
        id: "methods",
        title: "Methods",
        blocks: [
          {
            kind: "list",
            items: [
              `Each candidate: the same-${unit} correlation of its Kalshi change with ${i.stock}’s market-adjusted return, at the same window and resolution its page uses, with a wild bootstrap of 999 draws, so r, its interval, and “p (page)” are its page’s.`,
              `With 999 draws the smallest p is 0.001, too coarse for Holm’s 0.05/m in a large scan, so a candidate with p under ${SCAN_REFINE_BELOW.toFixed(2)} gets a finer p from ${SCAN_REFINE_DRAWS.toLocaleString("en-US")} fresh draws (“p (scan)”); the corrections use that.`,
              "Holm holds the chance of any false lead in the scan at 5%; Benjamini–Hochberg holds the expected share of false leads among those that survive at 5%. Candidates that couldn’t be tested are left out of both.",
              "F1: effective number of Kalshi moves (fragile under 10). F3: whether leaving out any one of the 10 most influential sessions changes the decision at 5% (run for the top 5 and other survivors).",
            ],
          },
        ],
      },
      {
        id: "results",
        title: "Results",
        blocks: [
          { kind: "callout", title: "Exploratory leads, not findings.", items: [chanceLine(under, tested.length), survivorsLine(holm, bh), `${WINNERS_CURSE}${median !== null ? ` For comparison, the median |r| across this scan is ${median.toFixed(2)}.` : ""}`, ...(note ? [note] : []), SCOPE_NOTE] },
          {
            kind: "table",
            id: "scan",
            head: SCAN_TABLE_HEAD,
            rows: scanRows(snap, candidates),
            note: "Ranked by adjusted p (both corrections keep the order of p). A correlation, not causation; its sign depends on what YES means for each market.",
          },
          ...(untested.length > 0
            ? [p(`Couldn’t be tested (left out of the corrections): ${untested.length}.`), { kind: "list" as const, items: untested.map(({ c, reason }) => `${c.ticker}: ${reason}`) }]
            : []),
        ],
      },
      reproducibilitySection(i.asOf ?? snap.prices?.fetchedAt ?? null, [
        "A frozen scan link lists the candidates it tested, so the same ones are tested again; a series or stored-events list made later can differ, as events open and close (and an event’s most-traded outcome can change).",
      ]),
      caveatsSection([
        "Candidates in the same series or event tend to move together, so several similar results there are not independent confirmations.",
        SCOPE_NOTE,
      ]),
    ],
    footer: { version: i.version, commit: i.commit, link: i.link, generatedAt: i.generatedAt },
  };
}

export const scanFileBase = (i: Pick<ScanReportInput, "stock" | "choice" | "resolution" | "candidates" | "generatedAt">) =>
  `eventlens-scan-report_${i.stock}_${i.candidates.length}-candidates_${i.choice === "all" ? "all" : `${i.choice}d`}-${i.resolution}_${new Date(i.generatedAt).toISOString().slice(0, 10)}`;
