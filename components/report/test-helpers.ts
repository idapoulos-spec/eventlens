// Reading a page's static markup back as text, tables, and numbers, so tests can compare a report
// with the page it came from.

const ENTITIES: Record<string, string> = { "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"', "&#x27;": "'", "&#39;": "'", "&nbsp;": " " };
const decode = (s: string) => s.replace(/&(?:amp|lt|gt|quot|nbsp|#x27|#39);/g, (e) => ENTITIES[e]);

/** The markup's text: tags removed, entities decoded, whitespace collapsed. */
export function textOf(html: string): string {
  return decode(html.replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").replace(/ ([.,:;)])/g, "$1").replace(/\( /g, "(").trim();
}

export interface PageTable {
  head: string[];
  rows: string[][];
}

/** Every <table> in the markup, in order: its header cells and its rows' cells, as text. */
export function tablesOf(html: string): PageTable[] {
  return [...html.matchAll(/<table\b[\s\S]*?<\/table>/g)].map(([table]) => {
    const cells = (row: string) => [...row.matchAll(/<t[hd]\b[^>]*>([\s\S]*?)<\/t[hd]>/g)].map((m) => textOf(m[1]));
    const head = /<thead\b[\s\S]*?<\/thead>/.exec(table)?.[0] ?? "";
    const body = /<tbody\b[\s\S]*?<\/tbody>/.exec(table)?.[0] ?? "";
    return { head: cells(head), rows: [...body.matchAll(/<tr\b[\s\S]*?<\/tr>/g)].map(([r]) => cells(r)) };
  });
}

/** The numbers in a text, as written ("−0.10", "+0.26", "0.072", "1,204", "45%", "5.0e-5"), with minus signs unified. */
export function numbersIn(text: string): string[] {
  return [...text.replace(/−/g, "-").matchAll(/[-+]?\d+(?:,\d{3})*(?:\.\d+)?(?:e-?\d+)?%?/g)].map((m) => m[0]);
}

/** Numbers in `text` that `page` doesn't have anywhere. */
export function numbersNotOn(text: string, page: string): string[] {
  const have = new Set(numbersIn(page));
  return numbersIn(text).filter((n) => !have.has(n));
}
