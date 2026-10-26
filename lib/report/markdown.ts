// A report as Markdown (GitHub-flavored, with tables). Charts aren't drawn: Markdown viewers
// differ in what they show, so each chart is named and its numbers are in the tables beside it.

import type { Block, Report } from "./model";
import { buildText, reportInstant } from "./format";

/** Text with Markdown's markup characters escaped, so a market's title can't turn into formatting or a link. */
const text = (s: string) => s.replace(/([\\`*_[\]<>#|~])/g, "\\$1");
const cell = (s: string) => text(s).replace(/\r?\n/g, " ");

function block(b: Block): string {
  switch (b.kind) {
    case "paragraph":
      return text(b.text);
    case "list":
      return b.items.map((i) => `- ${text(i)}`).join("\n");
    case "facts":
      return b.rows.map(([k, v]) => `- **${text(k)}:** ${text(v)}`).join("\n");
    case "table": {
      const head = `| ${b.head.map(cell).join(" | ")} |`;
      const rule = `|${b.head.map(() => " --- ").join("|")}|`;
      const rows = b.rows.map((r) => `| ${r.map(cell).join(" | ")} |`);
      return [head, rule, ...rows, ...(b.note ? ["", `_${text(b.note)}_`] : [])].join("\n");
    }
    case "callout":
      return [`> **${text(b.title)}**`, ...b.items.map((i) => `> - ${text(i)}`)].join("\n");
    case "chart":
      return `_Chart (in the printable report): ${text(b.alt)}._ ${text(b.caption)}`;
  }
}

export function renderMarkdown(report: Report): string {
  const lines = [`# ${text(report.kind)}: ${text(report.title)}`, ""];
  if (report.preparedBy) lines.push(`Prepared by ${text(report.preparedBy)}`, "");
  for (const s of report.sections) {
    lines.push(`## ${text(s.title)}`, "");
    for (const b of s.blocks) lines.push(block(b), "");
  }
  const { version, commit, link, generatedAt } = report.footer;
  lines.push("---", "", `${text(buildText(version, commit))}. Generated ${text(reportInstant(generatedAt))}.`, "");
  lines.push(link ? `Reproducible link (opens behind this EventLens site's sign-in): <${link}>` : "Link left out of this report; the settings are listed under Inputs.", "");
  return lines.join("\n");
}
