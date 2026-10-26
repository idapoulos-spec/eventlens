import { describe, expect, it } from "vitest";
import {
  createStudyStore,
  exportStudies,
  importStudies,
  MAX_NAME_LENGTH,
  MAX_STUDIES,
  parseStudies,
  readStudyLink,
  STUDIES_STORAGE_KEY,
  type SavedStudy,
} from "./saved";

const NOW = Date.UTC(2026, 9, 25, 16);
const ANALYSIS = "/?stock=NVDA&kalshi=KXFEDDECISION-26OCT-H25&window=30&asof=2026-10-07T18%3A02Z";
const SCAN = "/scan?stock=TLT&source=tickers&tickers=KXFEDDECISION-26DEC&asof=2026-10-07T18%3A02Z";

/** A Storage that keeps items in memory, optionally full. */
function memoryStorage({ full = false } = {}): Storage {
  const items = new Map<string, string>();
  return {
    get length() {
      return items.size;
    },
    clear: () => items.clear(),
    getItem: (k) => items.get(k) ?? null,
    key: (i) => [...items.keys()][i] ?? null,
    removeItem: (k) => void items.delete(k),
    setItem: (k, v) => {
      if (full) throw new DOMException("quota", "QuotaExceededError");
      items.set(k, v);
    },
  };
}

function store(storage: Storage | null = memoryStorage()) {
  let n = 0;
  let t = NOW;
  return { s: createStudyStore(() => storage, () => t++, () => `id-${++n}`), storage };
}

describe("readStudyLink", () => {
  it("rebuilds an analysis or scan link from what its page reads, with its kind and as-of time", () => {
    expect(readStudyLink(`${ANALYSIS}&utm=x`, NOW)).toEqual({ href: ANALYSIS, kind: "analysis", asOf: Date.UTC(2026, 9, 7, 18, 2) });
    expect(readStudyLink(SCAN, NOW)).toEqual({ href: SCAN, kind: "scan", asOf: Date.UTC(2026, 9, 7, 18, 2) });
    expect(readStudyLink("/?stock=NVDA&kalshi=KXFEDDECISION-26OCT-H25", NOW)).toMatchObject({ kind: "analysis", asOf: null });
  });

  it("rejects anything that isn't an analysis or scan on this site", () => {
    for (const href of ["https://evil.example/?stock=NVDA&kalshi=X", "//evil.example/scan", "/login", "/?stock=NVDA", "/?stock=NVDA&kalshi=KXFEDDECISION-26OCT-H25&asof=soon", "/scan?asof=2099-01-01T00:00Z", 42, null]) {
      expect(readStudyLink(href, NOW), String(href)).toBeNull();
    }
  });
});

describe("parseStudies", () => {
  const good = { id: "a", name: "  TLT   vs. Fed  ", note: "line 1\r\nline 2", href: ANALYSIS, savedAt: NOW - 1, headline: "r = +0.10", kind: "scan", extra: "dropped" };

  it("keeps readable entries, newest first, and derives the kind and as-of time from the link", () => {
    const list = parseStudies(JSON.stringify([good, { ...good, id: "b", href: SCAN, savedAt: NOW }]), NOW);
    expect(list.map((s) => s.id)).toEqual(["b", "a"]);
    expect(list[1]).toEqual({ id: "a", kind: "analysis", name: "TLT vs. Fed", note: "line 1\nline 2", href: ANALYSIS, savedAt: NOW - 1, asOf: Date.UTC(2026, 9, 7, 18, 2), headline: "r = +0.10" });
  });

  it("drops what it can't read, keeps each id once, and caps lengths and the list", () => {
    const entries = [good, { ...good }, { ...good, id: "c", href: "/login" }, { ...good, id: "d", name: "" }, { ...good, id: "e", savedAt: "x" }, "junk", null];
    expect(parseStudies(JSON.stringify(entries), NOW).map((s) => s.id)).toEqual(["a"]);
    expect(parseStudies("not json", NOW)).toEqual([]);
    expect(parseStudies(JSON.stringify({}), NOW)).toEqual([]);
    const long = parseStudies(JSON.stringify([{ ...good, name: "x".repeat(500) }]), NOW);
    expect(long[0].name).toHaveLength(MAX_NAME_LENGTH);
    const many = Array.from({ length: MAX_STUDIES + 5 }, (_, i) => ({ ...good, id: `s${i}`, savedAt: i }));
    expect(parseStudies(JSON.stringify(many), NOW)).toHaveLength(MAX_STUDIES);
  });
});

describe("createStudyStore", () => {
  it("saves, renames, re-notes, and deletes studies, newest first", () => {
    const { s, storage } = store();
    const first = s.save({ name: "First", note: "", href: ANALYSIS, headline: null })!;
    const second = s.save({ name: "Second", note: "why", href: SCAN, headline: "2 tested" })!;
    expect(first).toMatchObject({ id: "id-1", kind: "analysis", savedAt: NOW });
    expect(s.getSnapshot().map((x) => x.name)).toEqual(["Second", "First"]);
    expect(s.getSnapshot()).toBe(s.getSnapshot());

    expect(s.update(first.id, { note: "edited" })).toBe(true);
    expect(s.getSnapshot()[0]).toMatchObject({ id: first.id, note: "edited" });
    expect(s.update("missing", { name: "x" })).toBe(false);
    expect(s.update(second.id, { name: "  " })).toBe(false);

    expect(s.remove(first.id)).toBe(true);
    expect(s.getSnapshot().map((x) => x.id)).toEqual([second.id]);
    expect(JSON.parse(storage!.getItem(STUDIES_STORAGE_KEY)!)).toHaveLength(1);
  });

  it("refuses a link it can't open, and says so when storage is blocked or full", () => {
    expect(store().s.save({ name: "x", note: "", href: "/login", headline: null })).toBeNull();
    const blocked = store(null).s;
    expect(blocked.available()).toBe(false);
    expect(blocked.save({ name: "x", note: "", href: ANALYSIS, headline: null })).toBeNull();
    expect(blocked.getSnapshot()).toEqual([]);
    const full = store(memoryStorage({ full: true })).s;
    expect(full.available()).toBe(false);
    expect(full.save({ name: "x", note: "", href: ANALYSIS, headline: null })).toBeNull();
  });
});

describe("exportStudies and importStudies", () => {
  const study = (id: string, href: string, savedAt: number, name = id): SavedStudy => ({ id, kind: href.startsWith("/scan") ? "scan" : "analysis", name, note: "", href, savedAt, asOf: Date.UTC(2026, 9, 7, 18, 2), headline: null });

  it("round-trips a list through a file", () => {
    const list = [study("b", SCAN, NOW), study("a", ANALYSIS, NOW - 5)];
    const file = exportStudies(list, NOW);
    expect(JSON.parse(file)).toMatchObject({ format: "eventlens-saved-studies", version: 1, exportedAt: "2026-10-25T16:00:00.000Z" });
    expect(importStudies([], file, NOW)).toEqual({ list, added: 2, updated: 0, alreadySaved: 0, unreadable: 0, overLimit: 0, error: null });
  });

  it("merges: adds new ones, replaces older copies of the same study, and skips links already saved", () => {
    const here = [study("a", ANALYSIS, NOW - 10, "mine"), study("b", SCAN, NOW - 10)];
    const file = exportStudies(
      [
        study("a", ANALYSIS, NOW - 5, "newer copy"),
        study("b", SCAN, NOW - 20),
        study("c", SCAN, NOW - 1),
        study("d", "/?stock=TLT&kalshi=KXFEDDECISION-26DEC", NOW - 2),
        { ...study("e", ANALYSIS, NOW), href: "/login" },
      ],
      NOW,
    );
    const r = importStudies(here, file, NOW);
    expect(r).toMatchObject({ added: 1, updated: 1, alreadySaved: 2, unreadable: 1, overLimit: 0, error: null });
    expect(r.list!.map((s) => [s.id, s.name])).toEqual([
      ["d", "d"],
      ["a", "newer copy"],
      ["b", "b"],
    ]);
  });

  it("reads only its own format and version, and nothing too large", () => {
    expect(importStudies([], "nope", NOW).error).toMatch(/isn't JSON/);
    expect(importStudies([], JSON.stringify([study("a", ANALYSIS, NOW)]), NOW).error).toMatch(/isn't an EventLens studies export/);
    expect(importStudies([], JSON.stringify({ format: "eventlens-saved-studies", version: 2, studies: [] }), NOW).error).toMatch(/version/);
    expect(importStudies([], " ".repeat(2_000_001), NOW).error).toMatch(/too large/);
  });

  it("stores a merged import, and leaves the list alone when the file can't be read", () => {
    const { s } = store();
    s.save({ name: "here", note: "", href: ANALYSIS, headline: null });
    const file = exportStudies([study("x", SCAN, NOW)], NOW);
    expect(s.importFile(file)).toMatchObject({ added: 1, error: null });
    expect(s.getSnapshot().map((x) => x.name).sort()).toEqual(["here", "x"]);
    expect(s.importFile("{").error).not.toBeNull();
    expect(s.getSnapshot()).toHaveLength(2);
  });
});
