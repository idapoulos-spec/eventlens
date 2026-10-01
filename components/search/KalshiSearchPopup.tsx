import type { MouseEvent } from "react";
import type { KalshiSearchResult } from "@/lib/search/types";
import { formatChance, formatCloses, type SearchState } from "./KalshiSearchModel";

/** What screen readers hear about the popup (through a live region, since focus stays in the input). */
export function searchAnnouncement(state: SearchState): string {
  if (!state.open || state.query === null) return "";
  if (state.status === "error") return state.error ?? "";
  if (state.status !== "done") return "";
  const n = state.results.length;
  if (!n) return `No open markets match ${state.query}.`;
  return `${n === 1 ? "1 market" : `${n} markets`} found. Use the up and down arrows to choose one.`;
}

interface PopupProps {
  state: SearchState;
  listboxId: string;
  optionId: (index: number) => string;
  onPick: (result: KalshiSearchResult) => void;
  onHighlight: (index: number) => void;
  onRetry: () => void;
}

/** Results list and search status under the Kalshi field. The listbox is always rendered so the input can point at it. */
export function KalshiSearchPopup({ state, listboxId, optionId, onPick, onHighlight, onRetry }: PopupProps) {
  const { query, status, results, active } = state;
  const visible = state.open && query !== null;
  const showList = results.length > 0 && status !== "error";

  return (
    <div
      hidden={!visible}
      className="absolute inset-x-0 top-full z-30 mt-1 overflow-hidden rounded-lg border border-border bg-surface-raised shadow-xl shadow-black/50"
    >
      {status === "loading" && (
        <p className="flex items-center gap-2 px-3 py-2.5 text-sm text-ink-secondary">
          <span
            aria-hidden
            className="h-3.5 w-3.5 shrink-0 animate-spin rounded-full border-2 border-ink-muted/40 border-t-series-kalshi motion-reduce:animate-none"
          />
          {state.slow
            ? "Loading all of Kalshi's open markets. The first search can take up to half a minute…"
            : "Searching Kalshi markets…"}
        </p>
      )}

      <ul
        id={listboxId}
        role="listbox"
        aria-label="Kalshi markets"
        hidden={!showList}
        className={`max-h-[min(24rem,60vh)] overflow-y-auto overscroll-contain py-1 ${status === "loading" ? "opacity-60" : ""}`}
      >
        {showList &&
          results.map((result, i) => (
            <ResultOption
              key={result.ticker}
              id={optionId(i)}
              result={result}
              active={i === active}
              // Keep focus in the input, so picking doesn't close the popup before the click lands.
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => onPick(result)}
              onMouseMove={() => i !== active && onHighlight(i)}
            />
          ))}
      </ul>

      {status === "done" && !results.length && (
        <div className="px-3 py-3 text-sm">
          <p className="text-ink">
            No open markets match <span className="font-medium">“{query}”</span>.
          </p>
          <p className="mt-1 text-xs text-ink-secondary">Try fewer or different words, or type a market ticker.</p>
        </div>
      )}

      {status === "error" && (
        <div className="flex flex-wrap items-center justify-between gap-2 px-3 py-3 text-sm">
          <p className="text-down">{state.error}</p>
          <button
            type="button"
            onMouseDown={(e) => e.preventDefault()}
            onClick={onRetry}
            className="rounded-md border border-border px-2.5 py-1 text-xs font-medium text-ink-secondary transition hover:bg-surface hover:text-ink"
          >
            Try again
          </button>
        </div>
      )}

      {showList && (
        <p className="flex flex-wrap justify-between gap-x-3 border-t border-border px-3 py-1.5 text-[11px] text-ink-muted">
          <span>Open markets. Chances can be a few minutes old.</span>
          <span aria-hidden className="hidden sm:inline">
            ↑↓ choose · Enter pick · Esc close
          </span>
        </p>
      )}
    </div>
  );
}

interface ResultOptionProps {
  id: string;
  result: KalshiSearchResult;
  active: boolean;
  onMouseDown: (e: MouseEvent) => void;
  onClick: () => void;
  onMouseMove: () => void;
}

function ResultOption({ id, result, active, onMouseDown, onClick, onMouseMove }: ResultOptionProps) {
  const closes = formatCloses(result.closeTime);
  const meta = [result.category, closes].filter(Boolean).join(" · ");
  return (
    <li
      id={id}
      role="option"
      aria-selected={active}
      onMouseDown={onMouseDown}
      onClick={onClick}
      onMouseMove={onMouseMove}
      className={`flex cursor-pointer gap-3 px-3 py-2 ${active ? "bg-series-kalshi/15" : ""}`}
    >
      <div className="min-w-0 flex-1">
        <p className="line-clamp-2 text-sm leading-snug text-ink">{result.title}</p>
        <p className="mt-0.5 truncate text-xs text-ink-secondary">{result.eventTitle}</p>
        <p className="mt-0.5 text-xs text-ink-muted">
          {meta && <span>{meta} · </span>}
          <span className="font-mono break-all">{result.ticker}</span>
        </p>
      </div>
      <p className="shrink-0 text-right">
        <span className="block font-mono text-sm font-semibold text-ink">{formatChance(result.probability)}</span>
        <span className="block text-[11px] text-ink-muted">{result.probability === null ? "no quote" : "chance"}</span>
      </p>
    </li>
  );
}
