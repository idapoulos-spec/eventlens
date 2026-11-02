import { describe, expect, it } from "vitest";
import { renderHtml } from "@/lib/report/html";
import { renderMarkdown } from "@/lib/report/markdown";
import type { Report } from "@/lib/report/model";
import { asSentence } from "./analysisReport";
import { cleanAuthor, readAuthor, writeAuthor, AUTHOR_STORAGE_KEY } from "./author";

const report = (over: Partial<Report> = {}): Report => ({
  title: "TLT vs. KXFED*[x]",
  kind: "EventLens analysis report",
  preparedBy: null,
  sections: [
    {
      id: "inputs",
      title: "Inputs",
      blocks: [
        { kind: "facts", rows: [["Stock", "TLT"]] },
        { kind: "paragraph", text: "A <script>alert(1)</script> title & more" },
        { kind: "heading", text: "How big is it? <b>#1</b>" },
        { kind: "table", id: "t", head: ["Lag", "r"], rows: [["+1h", "a|b"]], note: "Note" },
        { kind: "callout", title: "Fragile", items: ["one"] },
      ],
    },
  ],
  footer: { version: "0.13.0", commit: "abcdef1234567890", link: "http://localhost/?stock=TLT&kalshi=X\"onload=1", generatedAt: Date.UTC(2026, 9, 25, 16) },
  ...over,
});

describe("renderMarkdown", () => {
  it("escapes Markdown's markup in text and table cells, and names the build, time, and link", () => {
    const md = renderMarkdown(report());
    expect(md).toContain("# EventLens analysis report: TLT vs. KXFED\\*\\[x\\]");
    expect(md).toContain("| +1h | a\\|b |");
    expect(md).toContain("\n### How big is it? \\<b\\>\\#1\\</b\\>\n");
    expect(md).toContain("A \\<script\\>alert(1)\\</script\\> title & more");
    expect(md).toContain("EventLens v0.13.0, commit abcdef123456. Generated Oct 25, 2026, 12:00 PM EDT (2026-10-25T16:00:00Z).");
    expect(md).toContain("Reproducible link (opens behind this EventLens site's sign-in): <http://localhost/?stock=TLT&kalshi=X\"onload=1>");
  });
});

describe("renderHtml", () => {
  it("is a standalone page with every piece of text escaped", () => {
    const html = renderHtml(report({ preparedBy: "Ida <b>&</b> co" }));
    expect(html.startsWith("<!doctype html>")).toBe(true);
    expect(html).toContain("<title>EventLens analysis report: TLT vs. KXFED*[x]</title>");
    expect(html).toContain("A &lt;script&gt;alert(1)&lt;/script&gt; title &amp; more");
    expect(html).toContain("<h3>How big is it? &lt;b&gt;#1&lt;/b&gt;</h3>");
    expect(html).not.toContain("<script>");
    expect(html).toContain("Prepared by Ida &lt;b&gt;&amp;&lt;/b&gt; co");
    expect(html).toContain('href="http://localhost/?stock=TLT&amp;kalshi=X&quot;onload=1"');
    expect(html).toContain("@media print");
  });
});

describe("the report's options", () => {
  it("leave the link out entirely, saying the settings are listed under Inputs", () => {
    const none = report({ footer: { ...report().footer, link: null } });
    for (const text of [renderMarkdown(none), renderHtml(none)]) {
      expect(text).not.toContain("http");
      expect(text).toContain("Link left out of this report; the settings are listed under Inputs.");
    }
  });

  it("show a Prepared by line only when there's a name", () => {
    expect(renderMarkdown(report())).not.toContain("Prepared by");
    expect(renderHtml(report())).not.toContain("Prepared by");
    expect(renderMarkdown(report({ preparedBy: "A. Reviewer" }))).toContain("Prepared by A. Reviewer");
  });

  it("remember the name in this browser, one line and at most 80 characters", () => {
    const items = new Map<string, string>();
    const storage = { getItem: (k: string) => items.get(k) ?? null, setItem: (k: string, v: string) => void items.set(k, v), removeItem: (k: string) => void items.delete(k) } as unknown as Storage;
    writeAuthor("  Ida\n  Poulos ", () => storage);
    expect(items.get(AUTHOR_STORAGE_KEY)).toBe("Ida Poulos");
    expect(readAuthor(() => storage)).toBe("Ida Poulos");
    writeAuthor("", () => storage);
    expect(readAuthor(() => storage)).toBe("");
    expect(cleanAuthor("x".repeat(200))).toHaveLength(80);
    expect(readAuthor(() => null)).toBe("");
    expect(
      readAuthor(() => {
        throw new Error("blocked");
      }),
    ).toBe("");
  });
});

describe("asSentence", () => {
  it("adds a period only where the text doesn't already end a sentence (Kalshi's titles are often questions)", () => {
    expect(asSentence("Will the Fed hold at its December 2026 meeting?")).toBe("Will the Fed hold at its December 2026 meeting?");
    expect(asSentence("Fed decision in December")).toBe("Fed decision in December.");
    expect(asSentence("Rates “held.”")).toBe("Rates “held.”");
  });
});
