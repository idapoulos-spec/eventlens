"use client";

import { useEffect, useState } from "react";

type Status = "idle" | "copied" | "failed";

const LABEL: Record<Status, string> = { idle: "Copy link", copied: "Copied", failed: "Couldn't copy" };
const ANNOUNCEMENT: Record<Status, string> = { idle: "", copied: "Link copied", failed: "Couldn't copy the link" };

/** Copies the full URL of `href`, a path on this site, so the analysis can be shared. */
export function CopyLinkButton({ href }: { href: string }) {
  const [status, setStatus] = useState<Status>("idle");

  useEffect(() => {
    if (status === "idle") return;
    const timer = setTimeout(() => setStatus("idle"), 2500);
    return () => clearTimeout(timer);
  }, [status]);

  async function copy() {
    try {
      // The clipboard is missing outside secure contexts, and may be blocked; both land in catch.
      await navigator.clipboard.writeText(new URL(href, window.location.origin).href);
      setStatus("copied");
    } catch {
      setStatus("failed");
    }
  }

  return (
    <>
      <button
        type="button"
        onClick={copy}
        className="inline-flex h-9 shrink-0 items-center gap-1.5 rounded-md border border-border px-3 text-xs font-medium text-ink-secondary transition hover:bg-surface-raised hover:text-ink sm:h-8"
      >
        <svg
          aria-hidden
          viewBox="0 0 24 24"
          className="h-3.5 w-3.5"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          {status === "copied" ? (
            <path d="M5 12.5l4.5 4.5L19 7" />
          ) : (
            <path d="M10 14a4 4 0 0 0 5.66 0l3-3a4 4 0 0 0-5.66-5.66l-1 1M14 10a4 4 0 0 0-5.66 0l-3 3a4 4 0 0 0 5.66 5.66l1-1" />
          )}
        </svg>
        {LABEL[status]}
      </button>
      <span role="status" className="sr-only">
        {ANNOUNCEMENT[status]}
      </span>
    </>
  );
}
