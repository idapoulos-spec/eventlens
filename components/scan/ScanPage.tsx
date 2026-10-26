"use client";

import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { ALPHA } from "@/lib/analytics/inference";
import { MAX_SCAN_CANDIDATES, SCAN_REFINE_BELOW, SCAN_REFINE_DRAWS } from "@/lib/analytics/scan";
import type { Resolution } from "@/lib/analytics/research";
import { formatDate, formatDateTime } from "@/lib/format";
import { fromNewYorkInput, newYorkInput, WINDOW_LABEL, WINDOWS, type WindowChoice } from "@/lib/history/window";
import { DEFAULT_BENCHMARK } from "@/lib/market-data/benchmark-series";
import type { CandidateList } from "@/lib/scan/candidates";
import { benchmarkFromCache, MAX_PRICE_REQUESTS, priceCredits, priceSpan } from "@/lib/scan/span";
import { SCAN_ASOF_PARAM } from "@/lib/scan/api";
import { SCAN_CANDIDATES_PATH, type ScanCandidate, type ScanErrorResponse } from "@/lib/scan/types";
import { validateStockTicker } from "@/lib/validation";
import { analysisHref } from "../analysis/navigation";
import { CopyLinkButton } from "../analysis/CopyLinkButton";
import { MAY_DIFFER, REPRODUCED } from "../analysis/reproducibility";
import { ControlBar } from "../analysis/ControlBar";
import { useSaveStudy } from "../studies/useSaveStudy";
import { formatSmallP, scanFileBase, scanReport } from "../report/scanReport";
import { useReportControl } from "../report/useReportControl";
import type { Report } from "@/lib/report/model";
import { APP_COMMIT, APP_VERSION } from "@/lib/report/version";
import { Caption, Flag, fmtR, Segmented } from "../research/parts";
import { formatCi } from "../research/stats";
import { KalshiSearch } from "../search/KalshiSearch";
import { StockSearch } from "../search/StockSearch";
import { Card, Notice } from "../ui";
import { ScanRun, type CandidateState, type ScanSnapshot } from "./scanRunner";
import { frozenScanHref, scanHref, type ScanLink, type Source } from "./link";
import { chanceLine, correlationNote, medianAbs, SCOPE_NOTE, survivorsLine, WINNERS_CURSE } from "./text";

const SOURCES: { value: Source; label: string }[] = [
  { value: "series", label: "A series" },
  { value: "stored", label: "Stored events" },
  { value: "tickers", label: "Custom list" },
];

export { formatSmallP };

const seconds = (ms: number | null) => (ms === null ? "—" : `${(ms / 1000).toFixed(1)} s`);

interface ListState {
  status: "idle" | "loading" | "ready" | "error";
  /** The request the list answers, so a changed form asks again. */
  key: string;
  list: CandidateList | null;
  error: string | null;
  /** When the list came in (ms): the cost is worked out as of then. */
  listedAt: number;
}

function listQuery(source: Source, series: string, settled: boolean, tickers: string, asOf: number | null): string {
  const frozen: Record<string, string> = asOf === null ? {} : { [SCAN_ASOF_PARAM]: String(asOf) };
  if (source === "series") return new URLSearchParams({ scope: "series", series, settled: settled ? "1" : "0", ...frozen }).toString();
  if (source === "stored") return new URLSearchParams({ scope: "stored", ...(series.trim() && { series }), ...frozen }).toString();
  return new URLSearchParams({ scope: "tickers", tickers, ...frozen }).toString();
}

/**
 * Keeps the address bar's link at the form's settings, so it opens the same scan. Nothing is
 * rewritten on load, only after a setting changes.
 */
function useScanLinkSync(link: ScanLink) {
  const href = scanHref(link);
  const synced = useRef<string | null>(null);
  useEffect(() => {
    if (synced.current === null || synced.current === href) {
      synced.current = href;
      return;
    }
    synced.current = href;
    if (href !== window.location.pathname + window.location.search) window.history.replaceState(null, "", href);
  }, [href]);
}

/** How a scan's candidates were chosen, in words, for its report. */
function selectionText(source: Source, series: string, settled: boolean, listedAt: number): string {
  const when = `listed ${formatDateTime(listedAt, { withYear: true })}`;
  if (source === "series") return `${series}’s open events${settled ? " and its stored settled events" : ""}, ${when}`;
  if (source === "stored") return `${series.trim() ? `${series.trim()}’s` : "every"} stored events, settled ones included, ${when}`;
  return `a custom list, ${when}`;
}

export function ScanPage({ initial }: { initial: ScanLink }) {
  const [stock, setStock] = useState(initial.stock);
  const [source, setSource] = useState<Source>(initial.source);
  const [series, setSeries] = useState(initial.series);
  const [settled, setSettled] = useState(initial.settled);
  const [tickers, setTickers] = useState(initial.tickers);
  const [search, setSearch] = useState("");
  const [choice, setChoice] = useState<WindowChoice>(initial.window);
  const [chosenResolution, setResolution] = useState<Resolution>(initial.resolution);
  const resolution: Resolution = choice === 7 ? "hourly" : chosenResolution;
  // Optional: windows still open at this New York time end there (a frozen scan); empty for now.
  const [asOfInput, setAsOfInput] = useState(initial.asOf === null ? "" : newYorkInput(initial.asOf));
  const asOf = asOfInput === "" ? null : fromNewYorkInput(asOfInput);
  const [listState, setListState] = useState<ListState>({ status: "idle", key: "", list: null, error: null, listedAt: 0 });
  const [run, setRun] = useState<{
    run: ScanRun;
    stock: string;
    choice: WindowChoice;
    resolution: Resolution;
    candidates: ScanCandidate[];
    asOf: number | null;
    /** The form's link when the scan started: a saved scan that isn't frozen lists its candidates again. */
    formHref: string;
    /** How the candidates were chosen, for a report. */
    selection: string;
  } | null>(null);
  const [stockError, setStockError] = useState<string | null>(null);
  const asOfError = asOfInput !== "" && asOf === null ? "Enter a New York date and time, or clear it to scan as of now." : null;

  useEffect(() => () => run?.run.dispose(), [run]);
  useScanLinkSync({ stock, source, series, settled, tickers, window: choice, resolution: chosenResolution, asOf });

  const query = listQuery(source, series, settled, tickers, asOf);
  const list = listState.key === query && listState.status === "ready" ? listState.list : null;

  async function findCandidates() {
    if (asOfError) return setListState({ status: "error", key: query, list: null, error: asOfError, listedAt: 0 });
    if (asOf !== null && asOf > Date.now()) return setListState({ status: "error", key: query, list: null, error: "Pick an as-of time in the past.", listedAt: 0 });
    setListState({ status: "loading", key: query, list: null, error: null, listedAt: 0 });
    try {
      const response = await fetch(`${SCAN_CANDIDATES_PATH}?${query}`);
      if (!response.ok) {
        const body = (await response.json().catch(() => null)) as ScanErrorResponse | null;
        return setListState({ status: "error", key: query, list: null, error: body?.error.message ?? "The candidates couldn't be listed.", listedAt: 0 });
      }
      setListState({ status: "ready", key: query, list: (await response.json()) as CandidateList, error: null, listedAt: Date.now() });
    } catch {
      setListState({ status: "error", key: query, list: null, error: "The server couldn't be reached.", listedAt: 0 });
    }
  }

  const listedAt = listState.listedAt;
  const cost = useMemo(() => {
    if (!list || list.candidates.length === 0) return null;
    const span = priceSpan(list.candidates, choice, listedAt, asOf)!;
    return { credits: priceCredits(span), cached: benchmarkFromCache(span, listedAt), span, stored: list.candidates.filter((c) => c.stored).length };
  }, [list, choice, listedAt, asOf]);

  function start() {
    const valid = validateStockTicker(stock);
    if (!valid.ok) return setStockError(valid.message);
    if (valid.value === DEFAULT_BENCHMARK.symbol) return setStockError(`${DEFAULT_BENCHMARK.symbol} is the benchmark; pick another stock.`);
    setStockError(null);
    if (!list || !cost || cost.credits > MAX_PRICE_REQUESTS) return;
    run?.run.dispose();
    setRun({
      run: new ScanRun({ stock: valid.value, choice, resolution, candidates: list.candidates, asOf }),
      stock: valid.value,
      choice,
      resolution,
      candidates: list.candidates,
      asOf,
      formHref: scanHref({ stock: valid.value, source, series, settled, tickers, window: choice, resolution: chosenResolution, asOf }),
      selection: selectionText(source, series, settled, listedAt),
    });
  }

  return (
    <div className="grid gap-4 sm:gap-5">
      <Card title="Scan one stock against many Kalshi events" subtitle="The same primary test on every candidate, then Holm and Benjamini–Hochberg across the whole scan">
        <div className="grid gap-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <div>
              <span className="mb-1.5 block text-xs font-medium text-ink-secondary">Stock</span>
              <StockSearch value={stock} onSelect={(ticker) => setStock(ticker)} invalid={stockError !== null} />
              {stockError && <p className="mt-1 text-xs text-down">{stockError}</p>}
            </div>
            <Segmented label="Candidates" value={source} options={SOURCES} onChange={setSource} />
          </div>

          {source === "series" && (
            <div className="flex flex-wrap items-end gap-4">
              <label className="text-xs font-medium text-ink-secondary">
                Series ticker
                <input value={series} onChange={(e) => setSeries(e.target.value.toUpperCase())} className="mt-1.5 block w-56 rounded-lg border border-border bg-surface-raised px-3 py-2 text-sm text-ink" />
              </label>
              <label className="flex items-center gap-2 pb-2 text-sm text-ink-secondary">
                <input type="checkbox" checked={settled} onChange={(e) => setSettled(e.target.checked)} />
                Also its stored settled events
              </label>
            </div>
          )}
          {source === "stored" && (
            <label className="text-xs font-medium text-ink-secondary">
              Series (optional; empty for every stored event)
              <input value={series} onChange={(e) => setSeries(e.target.value.toUpperCase())} className="mt-1.5 block w-56 rounded-lg border border-border bg-surface-raised px-3 py-2 text-sm text-ink" />
            </label>
          )}
          {source === "tickers" && (
            <div className="grid gap-3">
              <div>
                <span className="mb-1.5 block text-xs font-medium text-ink-secondary">Add from search (open markets and Fed decision events)</span>
                <KalshiSearch
                  value={search}
                  onSelect={(ticker, result) => {
                    if (!result) return setSearch(ticker);
                    setTickers((t) => (t.trim() ? `${t.trim()}\n${result.ticker}` : result.ticker));
                    setSearch("");
                  }}
                />
              </div>
              <label className="text-xs font-medium text-ink-secondary">
                Tickers (one per line, or separated by commas; events and markets, settled ones too)
                <textarea value={tickers} onChange={(e) => setTickers(e.target.value)} rows={4} className="mt-1.5 block w-full rounded-lg border border-border bg-surface-raised px-3 py-2 font-mono text-sm text-ink" />
              </label>
            </div>
          )}

          <div>
            <button type="button" onClick={findCandidates} disabled={listState.status === "loading"} className="inline-flex h-11 items-center justify-center rounded-lg border border-border px-4 text-sm font-medium text-ink-secondary transition hover:bg-surface-raised hover:text-ink disabled:pointer-events-none disabled:opacity-40 sm:h-10">
              {listState.status === "loading" && listState.key === query ? "Listing candidates…" : "List candidates"}
            </button>
          </div>
          {listState.status === "error" && listState.key === query && <Notice title="Candidates unavailable" message={listState.error ?? ""} />}
          {list && <CandidatePreview list={list} />}

          <div className="flex flex-wrap gap-4">
            <Segmented label="Window" value={choice} options={WINDOWS.map((w) => ({ value: w, label: WINDOW_LABEL[w] }))} onChange={setChoice} />
            <Segmented
              label="Resolution"
              value={resolution}
              options={[
                { value: "hourly", label: "Hourly" },
                { value: "daily", label: "Daily", disabled: choice === 7, title: "Seven days hold only about five daily closes." },
              ]}
              onChange={setResolution}
            />
            <label className="text-xs font-medium text-ink-secondary">
              As of (New York time; optional)
              <input
                type="datetime-local"
                value={asOfInput}
                onChange={(e) => setAsOfInput(e.target.value)}
                className="mt-1.5 block h-10 rounded-lg border border-border bg-surface-raised px-2 text-base text-ink sm:h-8 sm:text-xs"
              />
              <span className="mt-1 block font-normal text-ink-muted">
                {asOf !== null ? `Windows still open then end at ${formatDateTime(asOf, { withYear: true })}; closed ones at their close.` : "Empty: windows end now, or at each one’s close."}
              </span>
            </label>
          </div>
          {asOfError && <p className="text-xs text-down">{asOfError}</p>}

          {cost && (
            <p className="text-sm text-ink-secondary">
              {cost.credits > MAX_PRICE_REQUESTS ? (
                <>
                  These windows span {formatDate(cost.span.from)} to {formatDate(cost.span.to)}, which needs {cost.credits} Twelve Data requests; a scan may use {MAX_PRICE_REQUESTS} (the free plan’s limit a minute). Pick fewer settled events or a shorter window.
                </>
              ) : (
                <>
                  Cost: up to {cost.credits} Twelve Data credits{cost.cached ? " (fewer when the server has SPY in memory)" : ""}, for the stock’s and {DEFAULT_BENCHMARK.symbol}’s bars from {formatDate(cost.span.from)}, once for the whole scan. A single analysis costs 5. Kalshi: {cost.stored} of {list!.candidates.length} candidates read from the data store first, the rest live.
                </>
              )}
            </p>
          )}

          <div>
            <button
              type="button"
              onClick={start}
              disabled={!list || list.candidates.length === 0 || !cost || cost.credits > MAX_PRICE_REQUESTS}
              className="inline-flex h-11 items-center justify-center rounded-lg bg-series-kalshi px-5 text-sm font-semibold text-white transition hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-40 sm:h-10"
            >
              Run scan
            </button>
          </div>
        </div>
      </Card>

      {run && <ScanResults key={`${run.stock}|${run.choice}|${run.resolution}|${run.asOf ?? ""}`} {...run} />}
    </div>
  );
}

function CandidatePreview({ list }: { list: CandidateList }) {
  const picked = list.candidates.filter((c) => c.picked).length;
  return (
    <div className="text-sm text-ink-secondary">
      <p>
        {list.candidates.length} {list.candidates.length === 1 ? "candidate" : "candidates"}: {list.candidates.filter((c) => c.kind === "event").length} whole events (expected value),{" "}
        {list.candidates.filter((c) => c.kind === "market").length} markets{picked > 0 ? ` (${picked} standing in for an event with several outcomes: its outcome with the highest lifetime volume, among its open outcomes while the event is open, picked from the listing before any stock data loads)` : ""}.
        {list.truncated && ` Only the first ${MAX_SCAN_CANDIDATES} are kept.`}
      </p>
      <details className="mt-2 text-xs">
        <summary className="cursor-pointer text-ink-muted hover:text-ink-secondary">Show the list{list.skipped.length > 0 ? ` and ${list.skipped.length} left out` : ""}</summary>
        <ul className="mt-2 max-h-64 space-y-0.5 overflow-y-auto">
          {list.candidates.map((c) => (
            <li key={c.ticker}>
              <span className="font-mono">{c.ticker}</span> · {c.title}
              {c.label ? ` · ${c.label}` : ""}
              {c.end !== null ? ` · ended ${formatDate(c.end)}` : " · open"}
            </li>
          ))}
          {list.skipped.map((s) => (
            <li key={`skip-${s.ticker}`} className="text-ink-muted">
              <span className="font-mono">{s.ticker}</span> left out: {s.reason}
            </li>
          ))}
        </ul>
      </details>
    </div>
  );
}

export function ScanResults({
  run,
  stock,
  choice,
  resolution,
  candidates,
  asOf = null,
  formHref,
  selection = "",
}: {
  run: ScanRun;
  stock: string;
  choice: WindowChoice;
  resolution: Resolution;
  candidates: ScanCandidate[];
  /** A frozen scan's as-of time, or null for a live one. */
  asOf?: number | null;
  /** The form's link when it started, for saving the scan unfrozen. */
  formHref?: string;
  /** How the candidates were chosen, for a report. */
  selection?: string;
}) {
  const snap = useSyncExternalStore(run.subscribe, run.getSnapshot, run.getSnapshot);
  const { states, corrections, order } = snap;
  const done = states.filter((s) => s.status === "done").length;
  const untested = states.filter((s) => s.status === "untested").length;
  const pending = states.length - done - untested;
  const tested = states.flatMap((s, i) => (s.status === "done" ? [{ s, i }] : []));
  const under = tested.filter(({ s }) => (s.test.primary?.p ?? 1) < ALPHA).length;
  const holm = corrections.filter((c) => c?.survivesHolm).length;
  const bh = corrections.filter((c) => c?.survivesBh).length;
  const median = medianAbs(tested.flatMap(({ s }) => (s.test.primary?.estimate == null ? [] : [s.test.primary.estimate])));
  const note = correlationNote(tested.map(({ i }) => candidates[i]));
  const final = pending === 0;

  if (snap.phase === "failed") return <Notice title="The scan stopped" message={snap.error ?? "Something went wrong."} />;

  return (
    <Card
      title={`${stock} against ${candidates.length} ${candidates.length === 1 ? "candidate" : "candidates"} · ${WINDOW_LABEL[choice]} ${resolution}`}
      subtitle={
        asOf === null
          ? `Market-adjusted against ${DEFAULT_BENCHMARK.symbol}; each window ends where its own page’s does (its close, or now)`
          : `Market-adjusted against ${DEFAULT_BENCHMARK.symbol}; frozen as of ${formatDateTime(asOf, { withYear: true })}: each window ends there, or at its close if that came first`
      }
    >
      <div role="status" aria-live="polite" className="mb-4 text-sm text-ink-secondary">
        {snap.phase === "prices"
          ? snap.waitingUntil
            ? `Twelve Data’s free plan allows 8 requests a minute for everyone using this site’s key, and this minute’s are used up. The prices load again at ${new Date(snap.waitingUntil).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", second: "2-digit" })}; Kalshi’s histories keep loading meanwhile.`
            : "Loading the stock’s and the benchmark’s prices…"
          : final
            ? `All ${states.length} in: ${done} tested, ${untested} couldn’t be tested.${snap.phase === "leave_one_out" ? " Running the leave-one-out check on the top results…" : ""}`
            : `${done} tested, ${untested} couldn’t be tested, ${pending} still loading or computing.`}
      </div>

      <div className="mb-4 rounded-lg border border-warn/40 bg-surface-raised p-4 text-sm">
        <p className="font-medium text-ink">Exploratory leads, not findings.</p>
        <ul className="mt-2 list-disc space-y-1.5 pl-5 text-ink-secondary">
          <li>{chanceLine(under, tested.length)}</li>
          <li>
            {survivorsLine(holm, bh)}
            {!final && " So far: candidates still to come count as p = 1, so these can only grow, and a result marked as surviving keeps surviving."}
          </li>
          <li>{WINNERS_CURSE}{median !== null && ` For comparison, the median |r| across this scan is ${median.toFixed(2)}.`}</li>
          {note && <li>{note}</li>}
          <li>{SCOPE_NOTE}</li>
        </ul>
      </div>

      <ScanTable snap={snap} candidates={candidates} stock={stock} choice={choice} resolution={resolution} order={order} asOf={asOf} />

      <Caption
        lead={`Ranked by adjusted p (both corrections keep the order of p). Each candidate gets the primary test its own page runs: the same-${resolution === "hourly" ? "hour" : "day"} correlation of the Kalshi change with the stock’s market-adjusted return, at the same window and resolution, with 999 bootstrap draws, so r, the interval, and “p (page)” match its page.`}
        caveats={`With 999 draws the smallest p is 0.001, too coarse for Holm’s 0.05/m in a large scan, so a candidate with p under ${SCAN_REFINE_BELOW.toFixed(2)} gets a finer p from ${SCAN_REFINE_DRAWS.toLocaleString("en-US")} fresh draws (“p (scan)”), and the corrections use that. F1: effective number of Kalshi moves (fragile under 10). F3: leaving out any one of the 10 most influential sessions changes the decision at 5% (run for the top 5 and other survivors, as on its page; a borderline p can also cross from Monte Carlo error alone). A correlation, not causation; its sign depends on what YES means for each market.`}
      />

      {untested > 0 && (
        <details className="mt-3 text-xs">
          <summary className="cursor-pointer text-ink-muted hover:text-ink-secondary">Why {untested} couldn’t be tested (left out of the corrections)</summary>
          <ul className="mt-2 space-y-0.5 text-ink-secondary">
            {states.map((s, i) =>
              s.status === "untested" ? (
                <li key={candidates[i].ticker}>
                  <span className="font-mono">{candidates[i].ticker}</span>: {s.reason}
                </li>
              ) : null,
            )}
          </ul>
        </details>
      )}

      {snap.phase === "done" && <Timings snap={snap} />}
      {snap.phase === "done" && snap.prices && (
        <section data-report-controls="" className="mt-4 border-t border-border pt-3 text-xs text-ink-secondary">
          <FrozenScanLink
            stock={stock}
            candidates={candidates}
            choice={choice}
            resolution={resolution}
            asOf={asOf ?? snap.prices.fetchedAt}
            formHref={formHref}
            headline={`${tested.length} tested · ${holm} survive Holm · ${bh} survive BH`}
            report={(options) => scanReport({ stock, choice, resolution, candidates, snap, asOf, selection, ...options, generatedAt: Date.now(), version: APP_VERSION, commit: APP_COMMIT })}
            fileBase={scanFileBase({ stock, choice, resolution, candidates, generatedAt: snap.prices.fetchedAt })}
          />
        </section>
      )}
    </Card>
  );
}

/** The finished scan's frozen link, with Copy link, Save study, and Report beside it, and what it reproduces. */
function FrozenScanLink({
  stock,
  candidates,
  choice,
  resolution,
  asOf,
  formHref,
  headline,
  report,
  fileBase,
}: {
  stock: string;
  candidates: ScanCandidate[];
  choice: WindowChoice;
  resolution: Resolution;
  /** The link's as-of time: the scan's own, or when its prices were fetched. */
  asOf: number;
  formHref?: string;
  headline: string;
  /** The scan's report, given the reader's options and the link to put in it. */
  report: (options: { preparedBy: string | null; link: string | null }) => Report;
  fileBase: string;
}) {
  const frozen = frozenScanHref({ stock, candidates, window: choice, resolution, asOf });
  const saveControl = useSaveStudy({
    defaultName: `${stock} scan · ${candidates.length} ${candidates.length === 1 ? "candidate" : "candidates"} · ${WINDOW_LABEL[choice]} ${resolution}`,
    link: (freeze) => (freeze || !formHref ? frozen : formHref),
    freezeLabel: formHref
      ? `Freeze it: name these ${candidates.length} candidates and end their windows at ${formatDateTime(asOf, { withYear: true })}, so its link gives this table later (unticked, it lists the candidates again when opened)`
      : null,
    headline,
  });
  const reportControl = useReportControl({
    ready: true,
    pendingText: "",
    fileBase,
    build: ({ preparedBy, includeLink }) => report({ preparedBy, link: includeLink ? new URL(frozen, window.location.origin).href : null }),
  });
  return (
    <ControlBar
      lead={
        <span>
          Frozen link: names these {candidates.length} {candidates.length === 1 ? "candidate" : "candidates"} and ends their windows at{" "}
          {formatDateTime(asOf, { withYear: true })} (or each one’s close), so it opens this scan again; run it to get this table.
        </span>
      }
      controls={[{ buttons: <CopyLinkButton href={frozen} /> }, saveControl, reportControl]}
      notes={
        <details>
          <summary className="cursor-pointer text-ink-muted hover:text-ink-secondary">What a frozen link reproduces, and what can still change</summary>
          <ul className="mt-2 list-disc space-y-1 pl-5">
            {[...REPRODUCED, ...MAY_DIFFER, SCAN_LIST_NOTE].map((t) => (
              <li key={t}>{t}</li>
            ))}
          </ul>
        </details>
      }
    />
  );
}

export const SCAN_LIST_NOTE =
  "A frozen scan link lists the candidates it tested, so the same ones are tested again; a series or stored-events list made later can differ, as events open and close (and an event’s most-traded outcome can change).";

function looCell(state: Extract<CandidateState, { status: "done" }>) {
  const { loo } = state;
  if (loo === null || loo === "skipped") return <span className="text-ink-muted">—</span>;
  if (loo === "pending") return <span className="text-ink-muted">running…</span>;
  if (loo.flips > 0) return <Flag>flips in {loo.flips} of {loo.runs.length}</Flag>;
  return <span>stable{loo.p ? ` (p ${formatSmallP(loo.p[0])}–${formatSmallP(loo.p[1])})` : ""}</span>;
}

function ScanTable({
  snap,
  candidates,
  stock,
  choice,
  resolution,
  order,
  asOf,
}: {
  snap: ScanSnapshot;
  candidates: ScanCandidate[];
  stock: string;
  choice: WindowChoice;
  resolution: Resolution;
  order: number[];
  asOf: number | null;
}) {
  const rows = order.filter((i) => snap.states[i].status === "done");
  if (rows.length === 0) return <p className="text-sm text-ink-muted">Results appear here as each candidate finishes.</p>;
  const head = ["#", "Candidate", "r (95% CI)", "p (page)", "p (scan)", "Holm", "BH", "Survives", "F1 moves", "F3 leave-one-out", ""];
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-left text-xs tabular-nums">
        <thead className="text-ink-muted">
          <tr>
            {head.map((h, i) => (
              <th key={i} scope="col" className="whitespace-nowrap py-1 pr-3 font-medium">
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="text-ink-secondary">
          {rows.map((i, rank) => {
            const state = snap.states[i] as Extract<CandidateState, { status: "done" }>;
            const c = candidates[i];
            const corr = snap.corrections[i];
            const { primary, fragility, refined } = state.test;
            const survives = corr?.survivesHolm ? "Holm and BH" : corr?.survivesBh ? "BH only" : "—";
            const moves = fragility?.movement.effective ?? null;
            return (
              <tr key={c.ticker} className="border-t border-border align-top">
                <td className="py-1.5 pr-3">{rank + 1}</td>
                <td className="max-w-[18rem] py-1.5 pr-3">
                  <span className="block truncate text-ink" title={c.title}>
                    {c.title}
                  </span>
                  <span className="block font-mono text-[0.7rem] text-ink-muted">
                    {c.ticker}
                    {c.kind === "event" ? " · expected value" : c.label ? ` · ${c.label}` : ""}
                    {c.picked ? (c.picked.open !== null ? ` · most-traded of ${c.picked.open} open (${c.picked.outcomes} in all)` : ` · most-traded of ${c.picked.outcomes}`) : ""}
                    {c.end !== null ? ` · ended ${formatDate(c.end)}` : ""}
                    {state.sameAs90 ? " · same as 90D" : ""}
                  </span>
                </td>
                <td className="whitespace-nowrap py-1.5 pr-3">
                  {fmtR(primary?.estimate ?? null)} ({formatCi(primary?.ci ?? null, fmtR)})
                </td>
                <td className="py-1.5 pr-3">{formatSmallP(primary?.p ?? null)}</td>
                <td className="py-1.5 pr-3" title={refined ? `${refined.draws.toLocaleString("en-US")} draws` : "999 draws, as on its page"}>
                  {formatSmallP(state.test.p)}
                </td>
                <td className="py-1.5 pr-3">{formatSmallP(corr?.holm ?? null)}</td>
                <td className="py-1.5 pr-3">{formatSmallP(corr?.bh ?? null)}</td>
                <td className="whitespace-nowrap py-1.5 pr-3">{survives === "—" ? survives : <span className="font-medium text-ink">{survives}</span>}</td>
                <td className="whitespace-nowrap py-1.5 pr-3">{moves === null ? "—" : moves < 10 ? <Flag>{moves.toFixed(1)}</Flag> : moves.toFixed(1)}</td>
                <td className="whitespace-nowrap py-1.5 pr-3">{looCell(state)}</td>
                <td className="whitespace-nowrap py-1.5">
                  <a href={analysisHref({ stock, kalshi: c.ticker }, { window: choice, resolution, asOf })} target="_blank" rel="noopener" className="text-series-kalshi hover:underline">
                    Full analysis →
                  </a>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function Timings({ snap }: { snap: ScanSnapshot }) {
  const t = snap.timings;
  const mean = (v: number[]) => (v.length ? v.reduce((a, b) => a + b, 0) / v.length : null);
  return (
    <p className="mt-3 text-xs text-ink-muted">
      Prices in {seconds(t.prices)} ({snap.prices?.requests ?? 0} Twelve Data {snap.prices?.requests === 1 ? "request" : "requests"}); first result after {seconds(t.firstResult)}; every candidate in after {seconds(t.finished)};
      leave-one-out done after {seconds(t.leaveOneOut)}. Kalshi load {seconds(mean(t.loads))} on average; compute {mean(t.computes)?.toFixed(0) ?? "—"} ms per candidate; the page never went more than {t.longestSlice.toFixed(0)} ms without the main thread.
    </p>
  );
}
