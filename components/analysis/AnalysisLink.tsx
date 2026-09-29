"use client";

import Link from "next/link";
import type { ReactNode } from "react";
import { analysisHref, type Analysis } from "./navigation";

/**
 * A link to an analysis. It works as an ordinary link (open in a new tab, copy its
 * address, or click before JavaScript loads), but a plain click hands the analysis to
 * `onPick`, so it loads the same way as a submitted form. It's never prefetched, so no
 * analysis loads, and spends Twelve Data credits, until someone picks it.
 */
export function AnalysisLink({
  analysis,
  onPick,
  disabled = false,
  title,
  className,
  children,
}: {
  analysis: Analysis;
  onPick: (analysis: Analysis) => void;
  disabled?: boolean;
  title?: string;
  className?: string;
  children: ReactNode;
}) {
  return (
    <Link
      href={analysisHref(analysis)}
      prefetch={false}
      scroll={false}
      title={title}
      aria-disabled={disabled || undefined}
      onNavigate={(e) => {
        e.preventDefault();
        if (!disabled) onPick(analysis);
      }}
      className={className}
    >
      {children}
    </Link>
  );
}
