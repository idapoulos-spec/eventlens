import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { DEVICE_ONLY } from "./saved";
import { SaveStudy } from "./SaveStudy";
import { importSummary, StudiesPage } from "./StudiesPage";

// Static markup only: vitest runs in Node without a DOM, so the store's behavior is covered by saved.test.ts.

describe("StudiesPage", () => {
  it("says where studies live before this browser's list is known, and offers export and import", () => {
    const html = renderToStaticMarkup(<StudiesPage />);
    expect(html).toContain(DEVICE_ONLY);
    expect(html).toContain("Export to a file");
    expect(html).toContain("Import a file…");
    // The server knows no list, so it doesn't claim there are none.
    expect(html).not.toContain("None yet");
  });
});

describe("SaveStudy", () => {
  it("starts closed, as one button", () => {
    const html = renderToStaticMarkup(<SaveStudy defaultName="TLT vs. X" link={() => "/"} freezeLabel="Freeze it" headline={null} />);
    expect(html).toContain("Save study…");
    expect(html).not.toContain("Freeze it");
  });
});

describe("importSummary", () => {
  it("says what an import did in one line, or why it failed", () => {
    const base = { list: [], added: 2, updated: 0, alreadySaved: 1, unreadable: 0, overLimit: 0, error: null };
    expect(importSummary(base)).toBe("Added 2 · 1 already saved.");
    expect(importSummary({ ...base, updated: 1, unreadable: 3, overLimit: 4 })).toBe("Added 2 · updated 1 · 1 already saved · 3 unreadable · 4 over the limit of 200.");
    expect(importSummary({ ...base, list: null, error: "That file isn't an EventLens studies export." })).toBe("That file isn't an EventLens studies export.");
  });
});
