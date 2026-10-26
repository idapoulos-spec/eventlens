// The "Prepared by" name on reports, remembered in this browser only (never sent anywhere).

export const AUTHOR_STORAGE_KEY = "eventlens:report-author";
export const MAX_AUTHOR_LENGTH = 80;

/** A name as a report shows it: one line, at most MAX_AUTHOR_LENGTH characters; null if empty. */
export function cleanAuthor(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const chars = Array.from(value.replace(/\s+/g, " ").trim());
  return chars.length === 0 ? null : chars.slice(0, MAX_AUTHOR_LENGTH).join("");
}

/** The remembered name, or "" if none (or storage is blocked). */
export function readAuthor(getStorage: () => Storage | null = () => (typeof window === "undefined" ? null : window.localStorage)): string {
  try {
    return cleanAuthor(getStorage()?.getItem(AUTHOR_STORAGE_KEY)) ?? "";
  } catch {
    return "";
  }
}

/** Remembers the name (an empty one forgets it); does nothing if storage is blocked. */
export function writeAuthor(name: string, getStorage: () => Storage | null = () => (typeof window === "undefined" ? null : window.localStorage)): void {
  try {
    const storage = getStorage();
    const clean = cleanAuthor(name);
    if (clean) storage?.setItem(AUTHOR_STORAGE_KEY, clean);
    else storage?.removeItem(AUTHOR_STORAGE_KEY);
  } catch {
    // Not remembered; the report still uses the name.
  }
}
