// The bottom line and the glossary in a report: the first section says what the page's "The bottom
// line" card says, part by part, and the last lists every term the card defines. Both are built from
// the same summary as the card (components/plain/summary.ts), so they read the same.

import { FONT, GRID, INK, SURFACE } from "@/lib/report/charts";
import type { Block, Section } from "@/lib/report/model";
import { gaugeSvg, type GaugePalette } from "../plain/gaugeSvg";
import { GLOSSARY } from "../plain/glossary";
import { LEVEL_LABEL, RATING_METHOD, type BottomLine, type BottomLineGauge, type BottomLineTile } from "../plain/summary";

/** The correlation teal, the app's --series-correlation (gauge-colors.test.ts checks they match), on the report's light colors. */
export const REPORT_TEAL = "#199e70";
export const REPORT_GAUGE_PALETTE: GaugePalette = { teal: REPORT_TEAL, track: GRID, ink: INK, surface: SURFACE };

/**
 * The gauge as a report shows it: the same drawing as the card's (inline SVG in the printable page,
 * its label and line in Markdown, which names charts rather than drawing them), then its note; or why
 * there's none.
 */
export function gaugeBlocks(gauge: BottomLineGauge | null): Block[] {
  if (!gauge) return [];
  if (!gauge.drawn) return [{ kind: "paragraph", text: gauge.why }];
  const svg = gaugeSvg(gauge, "full", REPORT_GAUGE_PALETTE, { background: true, title: true, attributes: `${FONT} style="max-width:18rem"` });
  return [
    { kind: "chart", id: "gauge", svg, alt: gauge.label.replace(/\.$/, ""), caption: gauge.line },
    { kind: "paragraph", text: gauge.note },
  ];
}

/**
 * A tile as one line of text: "How sure? Weak. Fragile result.", or "Tested: 3 markets and events."
 * (a label that isn't a question takes a colon, and "Tested" reads straight on into its note).
 */
export function tileText({ id, label, value, note }: Pick<BottomLineTile, "id" | "label" | "value" | "note">): string {
  return `${label}${label.endsWith("?") ? "" : ":"} ${value}${id === "tested" ? " " : ". "}${note}${/[.?!]$/.test(note) ? "" : "."}`;
}

/** "The bottom line": the question, the answer, the gauge, the tiles, then the reasons, in the card's order, with the limits last. */
export function bottomLineSection(summary: BottomLine, { method }: { method: boolean }): Section {
  const evidence: Block = { kind: "paragraph", text: `Evidence: ${LEVEL_LABEL[summary.level]}` };
  const blocks: Block[] = [{ kind: "paragraph", text: summary.question }];
  // An analysis's rating is the card's badge, in its header; a scan's sits with the lead it rates.
  if (summary.sections.some((s) => s.id === "evidence") && summary.level !== "none") blocks.push(evidence);
  blocks.push({ kind: "paragraph", text: `${summary.verdict} ${summary.headline}` });
  // An analysis's gauge is under its answer; a scan's is with the lead it draws.
  const leadGauge = summary.sections.some((s) => s.id === "scan-lead");
  if (!leadGauge) blocks.push(...gaugeBlocks(summary.gauge));
  if (summary.tiles.length > 0) blocks.push({ kind: "list", items: summary.tiles.map(tileText) });
  for (const s of summary.sections) {
    if (s.id === "limits") continue;
    blocks.push({ kind: "heading", text: s.title });
    if (s.id === "scan-lead") {
      // The lead, its gauge, then the caution about leads at the top of a scan, as on the card.
      const [lead, ...rest] = s.items;
      blocks.push(evidence, { kind: "paragraph", text: lead }, ...gaugeBlocks(summary.gauge), ...rest.map((text): Block => ({ kind: "paragraph", text })));
    } else if (s.id === "trust") blocks.push({ kind: "list", items: s.items });
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
