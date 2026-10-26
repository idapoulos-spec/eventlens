"use client";

import { useState } from "react";
import { CONTROL_BUTTON as BUTTON, type Control } from "../analysis/ControlBar";
import { renderHtml } from "@/lib/report/html";
import { renderMarkdown } from "@/lib/report/markdown";
import type { Report, ReportOptions } from "@/lib/report/model";
import { cleanAuthor, MAX_AUTHOR_LENGTH, readAuthor, writeAuthor } from "./author";

/** How long a printable report's address keeps working after it opens (it lives in this tab's memory). */
const KEEP_PAGE_MS = 10 * 60 * 1000;

function download(text: string, type: string, name: string) {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  URL.revokeObjectURL(url);
}

/**
 * Exports what's on screen as a report: a printable page (opened in a new tab, to print or save as
 * PDF) or Markdown. The report is built in the browser from the page's own results, so it costs no
 * requests. `build` returns null when there's nothing to report. Its button, message, and form go
 * in a ControlBar.
 */
export function useReportControl({
  ready,
  pendingText,
  build,
  fileBase,
}: {
  ready: boolean;
  /** What the report waits for, while it isn't ready. */
  pendingText: string;
  build: (options: ReportOptions) => Report | null;
  fileBase: string;
}): Control {
  const [open, setOpen] = useState(false);
  const [author, setAuthor] = useState("");
  const [includeLink, setIncludeLink] = useState(true);
  const [status, setStatus] = useState<string | null>(null);

  function toggle() {
    if (!open) setAuthor(readAuthor());
    setOpen((o) => !o);
    setStatus(null);
  }

  function report(): Report | null {
    writeAuthor(author);
    const r = build({ preparedBy: cleanAuthor(author), includeLink });
    if (!r) setStatus("There’s nothing to report yet.");
    return r;
  }

  function printable() {
    const r = report();
    if (!r) return;
    const url = URL.createObjectURL(new Blob([renderHtml(r)], { type: "text/html" }));
    const tab = window.open(url, "_blank");
    if (!tab) {
      URL.revokeObjectURL(url);
      return setStatus("The browser blocked the new tab. Allow pop-ups for this site, or download the Markdown.");
    }
    setTimeout(() => URL.revokeObjectURL(url), KEEP_PAGE_MS);
    setStatus("Opened in a new tab: print it, or choose Save as PDF.");
  }

  function markdown() {
    const r = report();
    if (!r) return;
    download(renderMarkdown(r), "text/markdown;charset=utf-8", `${fileBase}.md`);
    setStatus("Downloaded.");
  }

  return {
    buttons: (
      <button type="button" onClick={toggle} className={BUTTON} aria-expanded={open} disabled={!ready} title={ready ? undefined : pendingText}>
        Report…
      </button>
    ),
    status: !ready ? <span className="text-ink-muted">{pendingText}</span> : status && <span role="status">{status}</span>,
    panel: open && ready && (
      <div className="grid max-w-xl gap-2 rounded-lg border border-border p-3">
        <label className="grid gap-1">
          <span>Prepared by (optional; remembered in this browser)</span>
          <input
            value={author}
            maxLength={MAX_AUTHOR_LENGTH}
            onChange={(e) => setAuthor(e.target.value)}
            className="h-10 rounded-lg border border-border bg-surface-raised px-2 text-base text-ink sm:h-8 sm:text-xs"
          />
        </label>
        <label className="flex items-start gap-2">
          <input type="checkbox" checked={includeLink} onChange={(e) => setIncludeLink(e.target.checked)} className="mt-0.5" />
          <span>Include the reproducible link (it opens behind this site’s sign-in). The settings are listed under Inputs either way.</span>
        </label>
        <p className="text-ink-muted">
          Statistics and Kalshi data only: no stock prices, price series, or price charts (Twelve Data’s terms). Built from this page,
          so it costs no data requests.
        </p>
        <div className="flex flex-wrap gap-2">
          <button type="button" onClick={printable} className={BUTTON}>
            Open printable report
          </button>
          <button type="button" onClick={markdown} className={BUTTON}>
            Download Markdown
          </button>
        </div>
      </div>
    ),
  };
}
