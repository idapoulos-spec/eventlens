import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { RecentAnalyses } from "./RecentAnalyses";

describe("RecentAnalyses", () => {
  it("takes up its line in the server's render, before this browser's list is known", () => {
    const html = renderToStaticMarkup(<RecentAnalyses exclude={null} disabled={false} onPick={() => {}} />);
    expect(html).toContain(">Recent</span>");
    // A chip-sized placeholder, hidden so it can't flash "None yet" before a list that has entries.
    expect(html).toMatch(/<p class="border border-transparent py-1\.5 text-ink-muted invisible">None yet<\/p>/);
  });
});
