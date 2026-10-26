// A report as a standalone, printable HTML page: inline styles only (no scripts but the Print
// button's), a light theme, and page breaks kept out of tables and charts. Opened in a new tab and
// printed (or saved as PDF) from the browser. Every piece of text is escaped; charts are SVG that
// charts.ts writes from numbers, with its own text escaped.

import type { Block, Report } from "./model";
import { buildText, reportInstant } from "./format";

export const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

const STYLE = `
  :root { color-scheme: light; }
  * { box-sizing: border-box; }
  body { margin: 0; background: #fff; color: #1c1f24; font: 14px/1.5 ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif; }
  main { max-width: 760px; margin: 0 auto; padding: 32px 20px 48px; }
  h1 { font-size: 22px; margin: 0 0 4px; }
  h2 { font-size: 16px; margin: 28px 0 8px; padding-bottom: 4px; border-bottom: 1px solid #d9dde3; break-after: avoid; }
  p, ul { margin: 0 0 10px; }
  ul { padding-left: 20px; }
  .kind { color: #5b6470; font-size: 13px; margin: 0 0 2px; text-transform: uppercase; letter-spacing: .06em; }
  .by { color: #3a414a; margin-bottom: 16px; }
  dl { display: grid; grid-template-columns: max-content 1fr; gap: 4px 16px; margin: 0 0 10px; }
  dt { color: #5b6470; }
  dd { margin: 0; }
  table { border-collapse: collapse; width: 100%; margin: 4px 0 6px; font-size: 12px; font-variant-numeric: tabular-nums; break-inside: avoid; }
  th, td { border-bottom: 1px solid #e3e6ea; padding: 4px 8px 4px 0; text-align: left; vertical-align: top; }
  th { color: #5b6470; font-weight: 600; }
  .note { color: #5b6470; font-size: 12px; }
  .callout { border: 1px solid #e0b252; background: #fffaf0; border-radius: 6px; padding: 10px 14px; margin: 4px 0 12px; break-inside: avoid; }
  .callout p { font-weight: 600; margin-bottom: 4px; }
  figure { margin: 8px 0 14px; break-inside: avoid; }
  figure svg { width: 100%; height: auto; display: block; }
  figcaption { color: #5b6470; font-size: 12px; margin-top: 4px; }
  footer { margin-top: 32px; padding-top: 10px; border-top: 1px solid #d9dde3; color: #5b6470; font-size: 12px; }
  footer a { color: #1d5fb8; word-break: break-all; }
  .toolbar { position: sticky; top: 0; background: #f4f6f8; border-bottom: 1px solid #d9dde3; padding: 8px 20px; text-align: right; }
  .toolbar button { font: inherit; padding: 6px 12px; border: 1px solid #b8bfc8; border-radius: 6px; background: #fff; cursor: pointer; }
  @page { margin: 16mm 14mm; }
  @media print { .toolbar { display: none; } main { padding: 0; max-width: none; } a { color: inherit; } }
`;

function block(b: Block): string {
  switch (b.kind) {
    case "paragraph":
      return `<p>${escapeHtml(b.text)}</p>`;
    case "list":
      return `<ul>${b.items.map((i) => `<li>${escapeHtml(i)}</li>`).join("")}</ul>`;
    case "facts":
      return `<dl>${b.rows.map(([k, v]) => `<dt>${escapeHtml(k)}</dt><dd>${escapeHtml(v)}</dd>`).join("")}</dl>`;
    case "table":
      return `<table><thead><tr>${b.head.map((h) => `<th scope="col">${escapeHtml(h)}</th>`).join("")}</tr></thead><tbody>${b.rows
        .map((r) => `<tr>${r.map((c) => `<td>${escapeHtml(c)}</td>`).join("")}</tr>`)
        .join("")}</tbody></table>${b.note ? `<p class="note">${escapeHtml(b.note)}</p>` : ""}`;
    case "callout":
      return `<div class="callout"><p>${escapeHtml(b.title)}</p><ul>${b.items.map((i) => `<li>${escapeHtml(i)}</li>`).join("")}</ul></div>`;
    case "chart":
      return `<figure>${b.svg}<figcaption>${escapeHtml(b.caption)}</figcaption></figure>`;
  }
}

export function renderHtml(report: Report): string {
  const { version, commit, link, generatedAt } = report.footer;
  const sections = report.sections.map((s) => `<section><h2>${escapeHtml(s.title)}</h2>${s.blocks.map(block).join("\n")}</section>`).join("\n");
  const linkLine = link
    ? `Reproducible link (opens behind this EventLens site’s sign-in): <a href="${escapeHtml(link)}">${escapeHtml(link)}</a>`
    : "Link left out of this report; the settings are listed under Inputs.";
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(`${report.kind}: ${report.title}`)}</title>
<style>${STYLE}</style>
</head>
<body>
<div class="toolbar"><button type="button" onclick="window.print()">Print or save as PDF</button></div>
<main>
<p class="kind">${escapeHtml(report.kind)}</p>
<h1>${escapeHtml(report.title)}</h1>
${report.preparedBy ? `<p class="by">Prepared by ${escapeHtml(report.preparedBy)}</p>` : ""}
${sections}
<footer><p>${escapeHtml(buildText(version, commit))}. Generated ${escapeHtml(reportInstant(generatedAt))}.</p><p>${linkLine}</p></footer>
</main>
</body>
</html>
`;
}
