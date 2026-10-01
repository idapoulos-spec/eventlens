"use client";

import { useEffect, useId, useSyncExternalStore } from "react";
import { AnalysisLink } from "./AnalysisLink";
import { sameAnalysis, type Analysis } from "./navigation";
import { NO_RECENT, recentAnalyses } from "./recent";

// The server knows nothing of this browser's list, so it renders none and the list
// appears once the page is running in the browser.
const serverSnapshot = () => NO_RECENT;

/** Analyses viewed recently in this browser, newest first, except the one on screen. */
export function RecentAnalyses({
  exclude,
  disabled,
  onPick,
}: {
  exclude: Analysis | null;
  disabled: boolean;
  onPick: (analysis: Analysis) => void;
}) {
  const labelId = useId();
  const stored = useSyncExternalStore(recentAnalyses.subscribe, recentAnalyses.getSnapshot, serverSnapshot);
  const recent = exclude === null ? stored : stored.filter((r) => !sameAnalysis(r, exclude));
  if (recent.length === 0) return null;

  return (
    <div className="mt-4 flex items-center gap-2 text-xs transition-opacity duration-300 starting:opacity-0 sm:items-baseline">
      <span id={labelId} className="shrink-0 text-ink-muted">
        Recent
      </span>
      {/* One scrolling row on phones, so the list never pushes the results down; wrapped on wider screens. */}
      <ul aria-labelledby={labelId} className="-m-1 flex min-w-0 gap-2 overflow-x-auto p-1 sm:flex-wrap sm:overflow-visible">
        {recent.map((r) => (
          <li
            key={`${r.stock}|${r.kalshi}`}
            className="flex max-w-64 shrink-0 rounded-md border border-border text-ink-secondary sm:max-w-xs"
          >
            <AnalysisLink
              analysis={r}
              onPick={onPick}
              disabled={disabled}
              title={r.title ? `${r.stock} vs. ${r.kalshi}: ${r.title}` : `${r.stock} vs. ${r.kalshi}`}
              className="flex min-w-0 items-center gap-1.5 rounded-l-md py-1.5 pr-1.5 pl-2.5 transition hover:bg-surface-raised hover:text-ink aria-disabled:cursor-wait aria-disabled:opacity-50"
            >
              <span className="font-mono text-ink">{r.stock}</span>
              <span className={`truncate ${r.title === null ? "font-mono" : ""}`}>{r.title ?? r.kalshi}</span>
            </AnalysisLink>
            <button
              type="button"
              onClick={() => recentAnalyses.remove(r)}
              aria-label={`Remove ${r.stock} vs. ${r.kalshi} from recent analyses`}
              title="Remove"
              className="flex shrink-0 items-center rounded-r-md px-2 text-ink-muted transition hover:bg-surface-raised hover:text-ink"
            >
              <svg aria-hidden viewBox="0 0 12 12" className="h-3 w-3">
                <path d="M3 3l6 6M9 3l-6 6" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
              </svg>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** Adds an analysis to this browser's recent analyses once it's on screen. */
export function RememberAnalysis({ stock, kalshi, title }: Analysis & { title: string | null }) {
  useEffect(() => {
    recentAnalyses.record({ stock, kalshi }, title);
  }, [stock, kalshi, title]);
  return null;
}
