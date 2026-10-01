import type { StockSearchResult } from "@/lib/search/types";
import { noMatchesMessage, SLOW_SEARCH_MESSAGE, type StockSearchState } from "./StockSearchState";

export const optionId = (listboxId: string, index: number) => `${listboxId}-${index}`;

function Searching({ slow }: { slow: boolean }) {
  return (
    <span className="flex items-start gap-2">
      <span
        aria-hidden
        className="mt-1 h-3 w-3 shrink-0 animate-spin rounded-full border-2 border-ink-muted/40 border-t-ink-muted motion-reduce:animate-none"
      />
      {slow ? SLOW_SEARCH_MESSAGE : "Searching…"}
    </span>
  );
}

/**
 * The popup under the stock field: results, or why there are none. While a new search runs,
 * the previous results stay, dimmed, so the list doesn't flicker as the user types.
 */
export function StockSearchList({
  state,
  listboxId,
  onPick,
  onHover,
}: {
  state: StockSearchState;
  listboxId: string;
  onPick: (result: StockSearchResult) => void;
  onHover: (index: number) => void;
}) {
  const { status, slow, results, active, error, query } = state;
  const loading = status === "loading";

  // Status text is announced through StockSearch's live region, so it's hidden from screen readers here.
  let message = null;
  if (loading) message = <Searching slow={slow} />;
  else if (status === "error") message = error;
  else if (status === "done" && results.length === 0) message = noMatchesMessage(query);

  return (
    // Pressing anywhere in the popup, even its scrollbar, keeps focus (and the popup) in the field.
    <div
      onMouseDown={(e) => e.preventDefault()}
      className="absolute left-0 top-full z-20 mt-1 w-full overflow-hidden rounded-lg border border-border bg-surface-raised shadow-xl shadow-black/50 sm:w-[22rem]"
    >
      {results.length > 0 && (
        <ul
          id={listboxId}
          role="listbox"
          aria-label="US stocks and ETFs"
          aria-busy={loading || undefined}
          className={`max-h-80 overflow-y-auto py-1 transition-opacity ${loading ? "opacity-50" : ""}`}
        >
          {results.map((result, i) => (
            <li
              key={result.symbol}
              id={optionId(listboxId, i)}
              role="option"
              aria-selected={i === active}
              onClick={() => onPick(result)}
              // Not onMouseEnter: that also fires when arrow keys scroll the list under a still pointer.
              onMouseMove={() => i !== active && onHover(i)}
              className={`flex cursor-pointer items-baseline gap-3 px-3 py-2 ${i === active ? "bg-series-kalshi/20" : ""}`}
            >
              <span className="min-w-16 shrink-0 font-mono text-sm font-semibold text-ink">{result.symbol}</span>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm text-ink-secondary">{result.name}</span>
                <span className="block truncate text-xs text-ink-muted">
                  {result.exchange ? `${result.exchange} · ${result.type}` : result.type}
                </span>
              </span>
            </li>
          ))}
        </ul>
      )}
      {message && (
        <p
          aria-hidden
          className={`px-3 py-2.5 text-sm ${status === "error" ? "text-ink-secondary" : "text-ink-muted"} ${
            results.length > 0 ? "border-t border-border" : ""
          }`}
        >
          {message}
        </p>
      )}
    </div>
  );
}
