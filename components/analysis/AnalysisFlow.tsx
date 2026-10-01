"use client";

import { useRouter } from "next/navigation";
import { createContext, use, useEffect, useRef, useTransition, type ReactNode, type RefObject } from "react";

interface AnalysisFlowValue {
  /** True while an analysis is loading. */
  pending: boolean;
  /** Load another analysis, then bring its results into view. */
  load(href: string): void;
  /** Reload the analysis in the URL, then bring its results into view. */
  reload(): void;
  /** Bring the results on screen into view. */
  reveal(): void;
  resultsRef: RefObject<HTMLElement | null>;
}

const AnalysisFlowContext = createContext<AnalysisFlowValue | null>(null);

export function useAnalysisFlow(): AnalysisFlowValue {
  const value = use(AnalysisFlowContext);
  if (!value) throw new Error("useAnalysisFlow must be used inside <AnalysisFlow>");
  return value;
}

function revealResults(results: HTMLElement | null) {
  if (!results) return;
  // On a phone the results start below the form, so scroll them up. On a wide screen
  // they're already in view, and the form stays where it is.
  const { top } = results.getBoundingClientRect();
  if (top < 0 || top > window.innerHeight * 0.4) {
    const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    results.scrollIntoView({ behavior: reduceMotion ? "auto" : "smooth", block: "start" });
  }
  // When the focused control is gone (a picked analysis leaves the recent list, a closed
  // on-screen keyboard), carry on from the results rather than the top of the page.
  if (document.activeElement === null || document.activeElement === document.body) {
    results.focus({ preventScroll: true });
  }
}

/**
 * Loads analyses for the form, and tracks the load so the results can dim while the
 * next ones load and come into view once they arrive.
 */
export function AnalysisFlow({ children }: { children: ReactNode }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const resultsRef = useRef<HTMLElement>(null);
  const revealWhenLoaded = useRef(false);

  useEffect(() => {
    if (pending || !revealWhenLoaded.current) return;
    revealWhenLoaded.current = false;
    revealResults(resultsRef.current);
  }, [pending]);

  const value: AnalysisFlowValue = {
    pending,
    resultsRef,
    load(href) {
      revealWhenLoaded.current = true;
      // The results scroll into view themselves, and only when they need to.
      startTransition(() => router.push(href, { scroll: false }));
    },
    reload() {
      revealWhenLoaded.current = true;
      startTransition(() => router.refresh());
    },
    reveal() {
      revealResults(resultsRef.current);
    },
  };

  return <AnalysisFlowContext value={value}>{children}</AnalysisFlowContext>;
}

/** Holds whatever the page shows below the form, dimmed while the next analysis loads. */
export function AnalysisResults({ label, children }: { label?: string; children: ReactNode }) {
  const { pending, resultsRef } = useAnalysisFlow();
  return (
    <section
      ref={resultsRef}
      // Focusable from script only, so focus can move here once results arrive.
      tabIndex={-1}
      aria-label={label}
      aria-busy={pending || undefined}
      className={`scroll-mt-4 transition-opacity duration-200 focus:outline-none motion-reduce:transition-none ${pending ? "opacity-50" : ""}`}
    >
      {children}
    </section>
  );
}
