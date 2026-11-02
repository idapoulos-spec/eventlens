// The plain-English summary and the glossary in a report: the first section says what the page's
// "In plain English" card says, part by part, and the last lists every term the card defines. Both
// are built from the same summary as the card (components/plain/summary.ts), so they read the same.

import type { Block, Section } from "@/lib/report/model";
import { GLOSSARY } from "../plain/glossary";
import { LEVEL_LABEL, RATING_METHOD, type PlainSummary } from "../plain/summary";

/** "In plain English": the headline, then each part under its own heading, the rating's part with its level. */
export function plainSection(summary: PlainSummary, { method }: { method: boolean }): Section {
  const blocks: Block[] = [{ kind: "paragraph", text: summary.headline }];
  for (const s of summary.sections) {
    blocks.push({ kind: "heading", text: s.title });
    if (s.id === "evidence" || s.id === "scan-lead") blocks.push({ kind: "paragraph", text: `Evidence: ${LEVEL_LABEL[summary.level]}` });
    if (s.id === "trust") blocks.push({ kind: "list", items: s.items });
    else for (const item of s.items) blocks.push({ kind: "paragraph", text: item });
  }
  if (method) {
    blocks.push({ kind: "heading", text: "How the rating works" });
    for (const text of RATING_METHOD) blocks.push({ kind: "paragraph", text });
  }
  return { id: "plain-english", title: "In plain English", blocks };
}

/** "Terms used": the glossary, as the card's "What the terms mean" lists it. */
export function termsSection(): Section {
  return { id: "terms", title: "Terms used", blocks: [{ kind: "facts", rows: GLOSSARY.map((e) => [e.term, e.definition]) }] };
}
