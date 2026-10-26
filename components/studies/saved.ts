// Saved studies: named links to analyses and scans, with notes, kept in this browser's
// localStorage. They never reach the server; a file export moves them between browsers.

import { parseScanLink, scanHref } from "../scan/link";
import { currentAnalysisHref } from "../analysis/navigation";
import { parseResearchLink } from "@/lib/history/window";

export interface SavedStudy {
  id: string;
  /** What the link opens: an analysis (the home page) or a scan. */
  kind: "analysis" | "scan";
  name: string;
  note: string;
  /** The link, path and query, rebuilt from what its page reads. */
  href: string;
  /** When it was saved or last edited (ms). */
  savedAt: number;
  /** The link's as-of time (ms), if it's frozen. */
  asOf: number | null;
  /** The main result when saved, e.g. "r = −0.10 (95% CI −0.23 to +0.00), p = 0.072". */
  headline: string | null;
}

export const STUDIES_STORAGE_KEY = "eventlens:saved-studies";
export const MAX_STUDIES = 200;
export const MAX_NAME_LENGTH = 120;
export const MAX_NOTE_LENGTH = 4_000;
const MAX_HEADLINE_LENGTH = 200;
const MAX_ID_LENGTH = 64;
/** An import file larger than this isn't read (200 studies with long notes are well under it). */
export const MAX_IMPORT_BYTES = 2_000_000;

export const EXPORT_FORMAT = "eventlens-saved-studies";
export const EXPORT_VERSION = 1;

/** The list before anything is stored; also what the server renders. */
export const NO_STUDIES: SavedStudy[] = [];

/** Text cut to `max` characters (not UTF-16 units, so emoji are never split); null if empty. */
function clean(value: unknown, max: number, { multiline = false } = {}): string | null {
  if (typeof value !== "string") return null;
  const text = (multiline ? value.replace(/\r\n?/g, "\n") : value.replace(/\s+/g, " ")).trim();
  if (!text) return null;
  const chars = Array.from(text);
  return chars.length > max ? chars.slice(0, max).join("") : text;
}

/**
 * A study's link as its page would read it, its kind, and its as-of time; null if it isn't a
 * link to an analysis or a scan on this site. Rebuilding drops anything else in it.
 */
export function readStudyLink(href: unknown, now: number): { href: string; kind: SavedStudy["kind"]; asOf: number | null } | null {
  if (typeof href !== "string" || !href.startsWith("/") || href.startsWith("//")) return null;
  let url: URL;
  try {
    url = new URL(href, "http://localhost");
  } catch {
    return null;
  }
  if (url.pathname === "/") {
    const rebuilt = currentAnalysisHref(url.search, now);
    if (!rebuilt) return null;
    const { view } = parseResearchLink((name) => url.searchParams.get(name), now);
    return { href: rebuilt, kind: "analysis", asOf: view.asOf ?? null };
  }
  if (url.pathname === "/scan") {
    const { link, asOf } = parseScanLink((name) => url.searchParams.get(name), now);
    if (!asOf.ok) return null;
    return { href: scanHref(link), kind: "scan", asOf: link.asOf };
  }
  return null;
}

/** Stored or imported data can be stale or edited by hand, so every entry is checked like URL input. */
export function parseStudy(value: unknown, now: number): SavedStudy | null {
  if (typeof value !== "object" || value === null) return null;
  const { id, name, note, href, savedAt, headline } = value as Record<string, unknown>;
  const cleanId = clean(id, MAX_ID_LENGTH);
  const cleanName = clean(name, MAX_NAME_LENGTH);
  const link = readStudyLink(href, now);
  if (!cleanId || !cleanName || !link) return null;
  if (typeof savedAt !== "number" || !Number.isFinite(savedAt)) return null;
  return {
    id: cleanId,
    kind: link.kind,
    name: cleanName,
    note: clean(note, MAX_NOTE_LENGTH, { multiline: true }) ?? "",
    href: link.href,
    savedAt,
    asOf: link.asOf,
    headline: clean(headline, MAX_HEADLINE_LENGTH),
  };
}

/** The stored list, newest first; anything unreadable is dropped, and each id is kept once. */
export function parseStudies(raw: string | null, now: number): SavedStudy[] {
  if (!raw) return [];
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(data)) return [];
  const list: SavedStudy[] = [];
  for (const item of data) {
    const study = parseStudy(item, now);
    if (study && !list.some((s) => s.id === study.id)) list.push(study);
  }
  return newestFirst(list).slice(0, MAX_STUDIES);
}

const newestFirst = (list: SavedStudy[]) => [...list].sort((a, b) => b.savedAt - a.savedAt);

/** What a new study needs; the id, kind, and time are added on saving. */
export interface NewStudy {
  name: string;
  note: string;
  href: string;
  headline: string | null;
}

/** The export file's contents. */
export function exportStudies(list: SavedStudy[], now: number): string {
  return JSON.stringify({ format: EXPORT_FORMAT, version: EXPORT_VERSION, exportedAt: new Date(now).toISOString(), studies: list }, null, 2);
}

export interface ImportResult {
  /** The merged list, or null when the file couldn't be read at all. */
  list: SavedStudy[] | null;
  added: number;
  /** Already saved here under the same id, now replaced by the file's newer copy. */
  updated: number;
  /** Already saved here: the same id (no newer), or the same link under another id. */
  alreadySaved: number;
  /** Entries in the file that aren't studies EventLens can open. */
  unreadable: number;
  /** Studies that didn't fit under MAX_STUDIES. */
  overLimit: number;
  /** Why the file couldn't be read at all. */
  error: string | null;
}

const NO_IMPORT = { added: 0, updated: 0, alreadySaved: 0, unreadable: 0, overLimit: 0 };

/**
 * Merges an export file into `list`: a study already here under the same id is replaced only by
 * a newer copy; one whose link is already saved under another id is skipped.
 */
export function importStudies(list: SavedStudy[], text: string, now: number): ImportResult {
  const failed = (error: string): ImportResult => ({ list: null, ...NO_IMPORT, error });
  if (text.length > MAX_IMPORT_BYTES) return failed("That file is too large to be an EventLens studies export.");
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return failed("That file isn't an EventLens studies export (it isn't JSON).");
  }
  const file = data as { format?: unknown; version?: unknown; studies?: unknown } | null;
  if (typeof file !== "object" || file === null || file.format !== EXPORT_FORMAT || !Array.isArray(file.studies)) {
    return failed("That file isn't an EventLens studies export.");
  }
  if (file.version !== EXPORT_VERSION) return failed("That export is from a version of EventLens this one can't read.");

  const merged = [...list];
  const counts = { ...NO_IMPORT };
  for (const item of file.studies) {
    const study = parseStudy(item, now);
    if (!study) {
      counts.unreadable++;
      continue;
    }
    const same = merged.findIndex((s) => s.id === study.id);
    if (same >= 0) {
      if (study.savedAt > merged[same].savedAt) {
        merged[same] = study;
        counts.updated++;
      } else counts.alreadySaved++;
      continue;
    }
    if (merged.some((s) => s.href === study.href)) {
      counts.alreadySaved++;
      continue;
    }
    if (merged.length >= MAX_STUDIES) {
      counts.overLimit++;
      continue;
    }
    merged.push(study);
    counts.added++;
  }
  return { list: newestFirst(merged), ...counts, error: null };
}

/** An external store for useSyncExternalStore. */
export interface StudyStore {
  subscribe(listener: () => void): () => void;
  /** Returns the same array until the stored list changes. */
  getSnapshot(): SavedStudy[];
  /** Whether this browser lets the site store anything. */
  available(): boolean;
  /** The saved study, or null if it couldn't be saved (an invalid link, storage blocked or full, or the list full). */
  save(study: NewStudy): SavedStudy | null;
  /** Renames or re-notes a study; false if that couldn't be stored. */
  update(id: string, changes: Partial<Pick<SavedStudy, "name" | "note">>): boolean;
  remove(id: string): boolean;
  /** Merges an export file; the list changes only if the file could be read and stored. */
  importFile(text: string): ImportResult;
}

/** A random id: crypto.randomUUID where there is one. */
function randomId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") return crypto.randomUUID();
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * When storage is unavailable (getStorage returns null or throws, e.g. with site data blocked)
 * or full, nothing changes and the call says so.
 */
export function createStudyStore(getStorage: () => Storage | null, now: () => number = Date.now, newId: () => string = randomId): StudyStore {
  const listeners = new Set<() => void>();
  let cachedRaw: string | null = null;
  let cached = NO_STUDIES;

  function read(): string | null {
    try {
      return getStorage()?.getItem(STUDIES_STORAGE_KEY) ?? null;
    } catch {
      return null;
    }
  }

  function getSnapshot(): SavedStudy[] {
    const raw = read();
    if (raw !== cachedRaw) {
      cachedRaw = raw;
      cached = parseStudies(raw, now());
    }
    return cached;
  }

  function write(list: SavedStudy[]): boolean {
    try {
      const storage = getStorage();
      if (!storage) return false;
      storage.setItem(STUDIES_STORAGE_KEY, JSON.stringify(list));
    } catch {
      return false;
    }
    for (const listener of listeners) listener();
    return true;
  }

  function subscribe(listener: () => void) {
    listeners.add(listener);
    // Changes made in other tabs arrive as storage events.
    const onStorage = (e: StorageEvent) => {
      if (e.key === STUDIES_STORAGE_KEY || e.key === null) listener();
    };
    if (typeof window !== "undefined") window.addEventListener("storage", onStorage);
    return () => {
      listeners.delete(listener);
      if (typeof window !== "undefined") window.removeEventListener("storage", onStorage);
    };
  }

  function available(): boolean {
    try {
      const storage = getStorage();
      if (!storage) return false;
      const probe = `${STUDIES_STORAGE_KEY}:probe`;
      storage.setItem(probe, "1");
      storage.removeItem(probe);
      return true;
    } catch {
      return false;
    }
  }

  function save(input: NewStudy): SavedStudy | null {
    const list = getSnapshot();
    if (list.length >= MAX_STUDIES) return null;
    const study = parseStudy({ ...input, id: newId(), savedAt: now() }, now());
    if (!study) return null;
    return write([study, ...list]) ? study : null;
  }

  function update(id: string, changes: Partial<Pick<SavedStudy, "name" | "note">>): boolean {
    const list = getSnapshot();
    const i = list.findIndex((s) => s.id === id);
    if (i < 0) return false;
    const study = parseStudy({ ...list[i], ...changes, savedAt: now() }, now());
    if (!study) return false;
    return write(newestFirst(list.map((s, j) => (j === i ? study : s))));
  }

  function remove(id: string): boolean {
    return write(getSnapshot().filter((s) => s.id !== id));
  }

  function importFile(text: string): ImportResult {
    const result = importStudies(getSnapshot(), text, now());
    if (result.list === null) return result;
    if (result.added + result.updated > 0 && !write(result.list)) {
      return { ...result, list: null, error: "This browser didn’t let EventLens store the studies (site data may be blocked or full)." };
    }
    return result;
  }

  return { subscribe, getSnapshot, available, save, update, remove, importFile };
}

/** This browser's saved studies. */
export const savedStudies = createStudyStore(() => (typeof window === "undefined" ? null : window.localStorage));

/** Where saved studies live, in the words every place that saves or lists them uses. */
export const DEVICE_ONLY =
  "Saved in this browser only. EventLens doesn’t keep them on its server, so they won’t appear on your other devices or browsers, and clearing this site’s data deletes them. Export a file to keep a copy or move them.";
