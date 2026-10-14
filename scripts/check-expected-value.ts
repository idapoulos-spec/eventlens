// Checks the app's expected-value engine against the fed-history study: for every meeting in the
// study's data/kalshi/marks.csv, it reads the event from the store as the app does (readStoredOutcomes,
// readStoredHistory, mapEvent) and computes E at the study's exact marks.
//
//   pnpm exec tsx --env-file-if-exists=.env.local --conditions=react-server scripts/check-expected-value.ts [study dir]
//
// The study dir defaults to ~/eventlens-studies/fed-history. Reads DATABASE_URL (the read-only
// app role). Prints counts only, never a price or an E value: per meeting, the marks compared,
// how many have the same missing reason, how many E values are bit-identical, and the largest
// |ΔE| in bp. Passes when every reason matches and every |ΔE| is at most 1e-9 bp; NumPy's dot
// product may sum in another order, so bit-identical is reported but not required. Exits 1 on a
// failure.

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { neon } from "@neondatabase/serverless";
import { expectedAt, LOOKBACK_MS, Outcome } from "@/lib/expected/engine";
import { storedOutcome } from "@/lib/expected/history";
import { mapEvent } from "@/lib/expected/mapping";
import { readStoredHistory, readStoredOutcomes } from "@/lib/expected/store";
import { httpSql } from "@/lib/store/sql";

const TOLERANCE_BP = 1e-9;

/** Rows of a CSV without quoted fields containing commas (the study's files have none). */
function readCsv(path: string): Record<string, string>[] {
  const [head, ...lines] = readFileSync(path, "utf8").trim().split(/\r?\n/);
  const columns = head.split(",");
  return lines.map((line) => {
    const cells = line.split(",");
    if (cells.length !== columns.length) throw new Error(`${path}: a row has ${cells.length} cells, not ${columns.length}`);
    return Object.fromEntries(columns.map((c, i) => [c, cells[i]]));
  });
}

async function main(): Promise<number> {
  const dir = process.argv[2] ?? join(homedir(), "eventlens-studies", "fed-history");
  const url = process.env.DATABASE_URL?.trim();
  if (!url) {
    console.error("DATABASE_URL isn't set. Set it in .env.local (the read-only eventlens_app role).");
    return 1;
  }
  const sql = httpSql(neon(url), { timeoutMs: 30_000 });

  const marks = readCsv(join(dir, "data", "kalshi", "marks.csv"));
  const studyOutcomes = readCsv(join(dir, "results", "kalshi_markets.csv"));
  const eventOf = new Map(studyOutcomes.map((r) => [r.meeting, r.event]));
  const studyValue = new Map(studyOutcomes.map((r) => [r.ticker, Number(r.bp)]));
  const meetings = [...new Set(marks.map((m) => m.meeting))];

  let failed = false;
  let totals = { marks: 0, sameReason: 0, withE: 0, identical: 0, maxDiff: 0 };
  console.log("meeting  event                 outcomes  values  marks  same reason  E both  bit-identical  max |ΔE| bp");
  for (const meeting of meetings) {
    const event = eventOf.get(meeting);
    const rows = marks.filter((m) => m.meeting === meeting);
    if (!event) {
      console.log(`${meeting}: no event in kalshi_markets.csv`);
      failed = true;
      continue;
    }
    const ts = rows.map((r) => Date.parse(r.t.replace(" ", "T")));
    const range = { from: Math.min(...ts) - LOOKBACK_MS, to: Math.max(...ts) };

    const stored = await readStoredOutcomes(sql, event);
    const mapping = mapEvent(stored.map((o) => o.raw), null);
    const history = await readStoredHistory(sql, event, range);
    const meta = new Map(stored.map((o) => [o.ticker, o]));
    const values = mapping.outcomes.filter((o) => studyValue.get(o.ticker) === o.value).length;
    if (mapping.outcomes.length === 0) {
      console.log(`${meeting.padEnd(8)} ${event.padEnd(21)} unmapped: ${mapping.problem ?? mapping.unmapped.map((u) => `${u.ticker} ${u.reason}`).join(", ")}`);
      failed = true;
      continue;
    }
    const outcomes = mapping.outcomes.map((o) => {
      const m = meta.get(o.ticker)!;
      return new Outcome(storedOutcome({ ticker: o.ticker, value: o.value, openTime: m.openTime, closeTime: m.closeTime }, history));
    });
    const ours = expectedAt(outcomes, ts);

    let same = 0;
    let both = 0;
    let identical = 0;
    let maxDiff = 0;
    rows.forEach((r, i) => {
      const theirs = r.E === "" ? null : Number(r.E);
      const mine = ours[i];
      if ((mine.missing ?? "") === r.missing) same++;
      if (theirs !== null && mine.value !== null) {
        both++;
        if (theirs === mine.value) identical++;
        maxDiff = Math.max(maxDiff, Math.abs(theirs - mine.value));
      }
    });
    const ok = same === rows.length && maxDiff <= TOLERANCE_BP && values === mapping.outcomes.length;
    if (!ok) failed = true;
    console.log(
      `${meeting.padEnd(8)} ${event.padEnd(21)} ${String(mapping.outcomes.length).padStart(8)}  ${String(values).padStart(6)}  ${String(rows.length).padStart(5)}  ${String(same).padStart(11)}  ${String(both).padStart(6)}  ${String(identical).padStart(13)}  ${maxDiff.toExponential(1).padStart(11)}${ok ? "" : "  FAIL"}`,
    );
    totals = {
      marks: totals.marks + rows.length,
      sameReason: totals.sameReason + same,
      withE: totals.withE + both,
      identical: totals.identical + identical,
      maxDiff: Math.max(totals.maxDiff, maxDiff),
    };
  }
  console.log(
    `\n${meetings.length} meetings: ${totals.sameReason} of ${totals.marks} marks have the same missing reason; ` +
      `${totals.identical} of ${totals.withE} E values bit-identical; max |ΔE| ${totals.maxDiff.toExponential(1)} bp. ${failed ? "FAIL" : "PASS"}`,
  );
  return failed ? 1 : 0;
}

main().then(
  (code) => process.exit(code),
  (err: unknown) => {
    // A driver message can name the host: print the error's name and code only.
    const code = (err as { code?: unknown } | null)?.code;
    console.error(`failed: ${err instanceof Error ? err.name : "error"}${typeof code === "string" ? ` (${code})` : ""}`);
    process.exit(1);
  },
);
