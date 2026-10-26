"use client";

import Link from "next/link";
import { useState } from "react";
import { DEVICE_ONLY, MAX_NAME_LENGTH, MAX_NOTE_LENGTH, savedStudies } from "./saved";

const BUTTON =
  "inline-flex h-9 items-center rounded-md border border-border px-2.5 font-medium text-ink-secondary transition hover:bg-surface-raised hover:text-ink sm:h-7";

/**
 * Saves the view as a study in this browser: a name, a note, and its link, frozen at its as-of
 * time unless unticked. `link` gives the link to save, frozen or not; null if there's none (no
 * valid analysis in the URL). `freezeLabel` is null when the view is already frozen.
 */
export function SaveStudy({
  defaultName,
  link,
  freezeLabel,
  headline,
  onFrozen,
}: {
  defaultName: string;
  link: (freeze: boolean) => string | null;
  freezeLabel: string | null;
  headline: string | null;
  /** Called when a frozen link was saved, so the page can show itself frozen too. */
  onFrozen?: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState(defaultName);
  const [note, setNote] = useState("");
  const [freeze, setFreeze] = useState(true);
  const [status, setStatus] = useState<{ ok: boolean; message: string } | null>(null);

  function save() {
    const href = link(freezeLabel !== null && freeze);
    if (!name.trim()) return setStatus({ ok: false, message: "Give the study a name." });
    if (!href) return setStatus({ ok: false, message: "There’s no analysis in this page’s link to save." });
    const saved = savedStudies.save({ name, note, href, headline });
    if (!saved) {
      return setStatus({
        ok: false,
        message: savedStudies.available()
          ? "Couldn’t save it: the list may be full (200 studies) or this browser’s storage full."
          : "This browser doesn’t let EventLens store anything (site data may be blocked), so studies can’t be saved here.",
      });
    }
    if (freezeLabel !== null && freeze) onFrozen?.();
    setStatus({ ok: true, message: `Saved “${saved.name}”.` });
    setOpen(false);
  }

  return (
    <div className="grid gap-2">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <button type="button" onClick={() => {
            setOpen((o) => !o);
            setStatus(null);
          }} className={BUTTON} aria-expanded={open}>
          Save study…
        </button>
        {status && (
          <span role="status" className={status.ok ? "" : "text-down"}>
            {status.message}{" "}
            {status.ok && (
              <Link href="/studies" className="text-series-kalshi hover:underline">
                Saved studies
              </Link>
            )}
          </span>
        )}
      </div>
      {open && (
        <div className="grid max-w-xl gap-2 rounded-lg border border-border p-3">
          <label className="grid gap-1">
            <span>Name</span>
            <input
              value={name}
              maxLength={MAX_NAME_LENGTH}
              onChange={(e) => setName(e.target.value)}
              className="h-10 rounded-lg border border-border bg-surface-raised px-2 text-base text-ink sm:h-8 sm:text-xs"
            />
          </label>
          <label className="grid gap-1">
            <span>Note (optional)</span>
            <textarea
              value={note}
              maxLength={MAX_NOTE_LENGTH}
              rows={3}
              onChange={(e) => setNote(e.target.value)}
              className="rounded-lg border border-border bg-surface-raised px-2 py-1.5 text-base text-ink sm:text-xs"
            />
          </label>
          {freezeLabel !== null && (
            <label className="flex items-start gap-2">
              <input type="checkbox" checked={freeze} onChange={(e) => setFreeze(e.target.checked)} className="mt-0.5" />
              <span>{freezeLabel}</span>
            </label>
          )}
          <p className="text-ink-muted">{DEVICE_ONLY}</p>
          <div className="flex gap-2">
            <button type="button" onClick={save} className={BUTTON}>
              Save
            </button>
            <button type="button" onClick={() => setOpen(false)} className={BUTTON}>
              Cancel
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
