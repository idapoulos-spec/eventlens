"use client";

import { useRef, useState, useSyncExternalStore, type ChangeEvent } from "react";
import { formatDateTime } from "@/lib/format";
import { Card, Notice } from "../ui";
import { DEVICE_ONLY, exportStudies, MAX_IMPORT_BYTES, MAX_NAME_LENGTH, MAX_NOTE_LENGTH, NO_STUDIES, savedStudies, type ImportResult, type SavedStudy } from "./saved";

// The server knows nothing of this browser's list, so it renders none and the list appears once
// the page runs in the browser.
const serverSnapshot = () => NO_STUDIES;
const subscribeNever = () => () => {};
const known = () => true;
const unknown = () => false;

const BUTTON =
  "inline-flex h-9 items-center rounded-md border border-border px-2.5 text-xs font-medium text-ink-secondary transition hover:bg-surface-raised hover:text-ink sm:h-8";

/** What an import did, in one line. */
export function importSummary(r: ImportResult): string {
  if (r.error) return r.error;
  const parts = [
    `Added ${r.added}`,
    r.updated > 0 && `updated ${r.updated}`,
    `${r.alreadySaved} already saved`,
    r.unreadable > 0 && `${r.unreadable} unreadable`,
    r.overLimit > 0 && `${r.overLimit} over the limit of 200`,
  ].filter(Boolean);
  return `${parts.join(" · ")}.`;
}

/** This browser's saved studies: open, rename, note, delete, and export or import them as a file. */
export function StudiesPage() {
  const studies = useSyncExternalStore(savedStudies.subscribe, savedStudies.getSnapshot, serverSnapshot);
  const loaded = useSyncExternalStore(subscribeNever, known, unknown);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const canStore = loaded && savedStudies.available();

  function download() {
    const blob = new Blob([exportStudies(studies, Date.now())], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `eventlens-studies-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(url);
  }

  async function upload(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    if (file.size > MAX_IMPORT_BYTES) return setMessage({ ok: false, text: "That file is too large to be an EventLens studies export." });
    const result = savedStudies.importFile(await file.text());
    setMessage({ ok: result.error === null, text: importSummary(result) });
  }

  return (
    <div className="grid gap-4 sm:gap-5">
      <Card title="Saved studies" subtitle="Named links to analyses and scans, with your notes">
        <p className="text-sm text-ink-secondary">{DEVICE_ONLY}</p>
        {loaded && !canStore && (
          <div className="mt-3">
            <Notice tone="info" title="Can’t save here" message="This browser doesn’t let EventLens store anything (site data may be blocked), so studies can’t be saved or imported here." />
          </div>
        )}
        <div className="mt-4 flex flex-wrap items-center gap-2">
          <button type="button" onClick={download} disabled={studies.length === 0} className={`${BUTTON} disabled:cursor-not-allowed disabled:opacity-40`}>
            Export to a file
          </button>
          <button type="button" onClick={() => fileRef.current?.click()} disabled={!canStore} className={`${BUTTON} disabled:cursor-not-allowed disabled:opacity-40`}>
            Import a file…
          </button>
          <input ref={fileRef} type="file" accept="application/json,.json" onChange={upload} className="hidden" />
          {message && (
            <span role="status" className={`text-xs ${message.ok ? "text-ink-secondary" : "text-down"}`}>
              {message.text}
            </span>
          )}
        </div>
        <p className="mt-2 text-xs text-ink-muted">
          An export is a JSON file of these studies (names, notes, and links). Importing adds the ones not already saved here,
          replaces older copies of the same study, and skips links already saved.
        </p>
      </Card>

      {loaded && studies.length === 0 ? (
        <p className="text-sm text-ink-muted">None yet. Use “Save study…” under an analysis’s Research controls or a finished scan.</p>
      ) : (
        <ul className="grid gap-3">
          {studies.map((s) => (
            <StudyItem key={s.id} study={s} />
          ))}
        </ul>
      )}
    </div>
  );
}

function StudyItem({ study }: { study: SavedStudy }) {
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(study.name);
  const [note, setNote] = useState(study.note);
  const [error, setError] = useState<string | null>(null);

  function save() {
    if (!name.trim()) return setError("Give the study a name.");
    if (!savedStudies.update(study.id, { name, note })) return setError("Couldn’t save the change in this browser.");
    setError(null);
    setEditing(false);
  }

  function remove() {
    if (window.confirm(`Delete “${study.name}” from this browser’s saved studies?`)) savedStudies.remove(study.id);
  }

  return (
    <li className="rounded-xl border border-border bg-surface p-4 text-sm">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <a href={study.href} className="font-medium text-ink hover:underline">
            {study.name}
          </a>
          <p className="mt-0.5 text-xs text-ink-muted">
            {study.kind === "scan" ? "Scan" : "Analysis"} · {study.asOf === null ? "live (the numbers change as new data arrives)" : `frozen as of ${formatDateTime(study.asOf, { withYear: true })}`} · saved{" "}
            {formatDateTime(study.savedAt, { withYear: true })}
          </p>
          {study.headline && <p className="mt-1 text-xs text-ink-secondary">When saved: {study.headline}</p>}
        </div>
        <div className="flex shrink-0 gap-2">
          <button type="button" onClick={() => setEditing((e) => !e)} className={BUTTON} aria-expanded={editing}>
            Edit
          </button>
          <button type="button" onClick={remove} className={BUTTON}>
            Delete
          </button>
        </div>
      </div>
      {editing ? (
        <div className="mt-3 grid max-w-xl gap-2 text-xs">
          <label className="grid gap-1">
            <span className="text-ink-secondary">Name</span>
            <input value={name} maxLength={MAX_NAME_LENGTH} onChange={(e) => setName(e.target.value)} className="h-10 rounded-lg border border-border bg-surface-raised px-2 text-base text-ink sm:h-8 sm:text-xs" />
          </label>
          <label className="grid gap-1">
            <span className="text-ink-secondary">Note</span>
            <textarea value={note} maxLength={MAX_NOTE_LENGTH} rows={4} onChange={(e) => setNote(e.target.value)} className="rounded-lg border border-border bg-surface-raised px-2 py-1.5 text-base text-ink sm:text-xs" />
          </label>
          <div className="flex items-center gap-2">
            <button type="button" onClick={save} className={BUTTON}>
              Save
            </button>
            <button type="button" onClick={() => {
                setEditing(false);
                setName(study.name);
                setNote(study.note);
              }} className={BUTTON}>
              Cancel
            </button>
            {error && <span className="text-down">{error}</span>}
          </div>
        </div>
      ) : (
        study.note && <p className="mt-2 whitespace-pre-wrap text-xs text-ink-secondary">{study.note}</p>
      )}
    </li>
  );
}
