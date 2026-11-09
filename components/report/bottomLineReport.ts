// The bottom line and the glossary in a report: the first section says what the page's "The bottom
// line" card says, part by part, and the last lists every term the card defines. Both are built from
// the same summary as the card (components/plain/summary.ts), so they read the same.

import type { Block, Section } from "@/lib/report/model";
import { GLOSSARY } from "../plain/glossary";
import { LEVEL_LABEL, RATING_METHOD, type BottomLine, type BottomLineTile } from "../plain/summary";

/** A tile as a line of text: its bold answer and its note ("Tested" reads straight on, "3 markets and events"). */
export function tileText({ id, value, note }: Pick<BottomLineTile, "id" | "value" | "note">): string {
  return `${value}${id === "tested" ? " " : ". "}${note}${/[.?!]$/.test(note) ? "" : "."}`;
}

/** "The bottom line": the question, the answer, the tiles, then the reasons, in the card's order, with the limits last. */
export function bottomLineSection(summary: BottomLine, { method }: { method: boolean }): Section {
  const evidence: Block = { kind: "paragraph", text: `Evidence: ${LEVEL_LABEL[summary.level]}` };
  const blocks: Block[] = [{ kind: "paragraph", text: summary.question }];
  // An analysis's rating is the card's badge, in its header; a scan's sits with the lead it rates.
  if (summary.sections.some((s) => s.id === "evidence") && summary.level !== "none") blocks.push(evidence);
  blocks.push({ kind: "paragraph", text: `${summary.verdict} ${summary.headline}` });
  if (summary.tiles.length > 0) blocks.push({ kind: "facts", rows: summary.tiles.map((t) => [t.label, tileText(t)]) });
  for (const s of summary.sections) {
    if (s.id === "limits") continue;
    blocks.push({ kind: "heading", text: s.title });
    if (s.id === "scan-lead") blocks.push(evidence);
    if (s.id === "trust") blocks.push({ kind: "list", items: s.items });
    else for (const item of s.items) blocks.push({ kind: "paragraph", text: item });
  }
  if (method) {
    blocks.push({ kind: "heading", text: "How the rating works" });
    for (const text of RATING_METHOD) blocks.push({ kind: "paragraph", text });
  }
  blocks.push({ kind: "paragraph", text: summary.sections.find((s) => s.id === "limits")!.items.join(" ") });
  return { id: "bottom-line", title: "The bottom line", blocks };
}

/** "Terms used": the glossary, as the card's "What the terms mean" lists it. */
export function termsSection(): Section {
  return { id: "terms", title: "Terms used", blocks: [{ kind: "facts", rows: GLOSSARY.map((e) => [e.term, e.definition]) }] };
}
