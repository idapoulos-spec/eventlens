// A report as plain data: sections of text, lists, facts, tables, and charts. Built in the browser
// from what a page already shows (components/report), then written out as Markdown or as a
// printable page (markdown.ts, html.ts). Reports carry statistics and Kalshi data only: no stock
// prices, price series, or price charts (Twelve Data's free plan doesn't allow showing its data
// outside the app; see components/report/licensing.test.tsx).

export type Block =
  | { kind: "paragraph"; text: string }
  /** A heading within a section, for a section in parts (the plain-English summary). */
  | { kind: "heading"; text: string }
  | { kind: "list"; items: string[] }
  /** Label and value pairs. */
  | { kind: "facts"; rows: [string, string][] }
  | { kind: "table"; id: string; head: string[]; rows: string[][]; note?: string }
  /** A warning or banner: a title and its points. */
  | { kind: "callout"; title: string; items: string[] }
  /** An inline SVG chart (charts.ts), with a text alternative. */
  | { kind: "chart"; id: string; svg: string; alt: string; caption: string };

export interface Section {
  id: string;
  title: string;
  blocks: Block[];
}

export interface Report {
  /** The page and file title, e.g. "TLT vs. KXFEDDECISION-26DEC". */
  title: string;
  /** What the report is: "Analysis report" or "Scan report". */
  kind: string;
  preparedBy: string | null;
  sections: Section[];
  footer: {
    version: string;
    commit: string;
    /** The reproducible link (absolute), or null when left out. */
    link: string | null;
    generatedAt: number;
  };
}

/** What the reader chooses when exporting. */
export interface ReportOptions {
  preparedBy: string | null;
  includeLink: boolean;
}

/** The text a section's numbers are read from in tests: every paragraph, list item, fact, and cell. */
export function sectionText(section: Section): string {
  return section.blocks
    .map((b) => {
      switch (b.kind) {
        case "paragraph":
        case "heading":
          return b.text;
        case "list":
          return b.items.join("\n");
        case "facts":
          return b.rows.map(([k, v]) => `${k}: ${v}`).join("\n");
        case "table":
          return [b.head.join(" | "), ...b.rows.map((r) => r.join(" | ")), b.note ?? ""].join("\n");
        case "callout":
          return [b.title, ...b.items].join("\n");
        case "chart":
          return `${b.alt}\n${b.caption}`;
      }
    })
    .join("\n");
}
