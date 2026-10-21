// Measures, for the default-window decision (feat/long-windows plan, part 5), how much history the
// open Fed decision markets and events have and how much their Kalshi side moves in longer windows.
// Kalshi only: it reads the store (DATABASE_URL, the read-only app role) and never looks at stock
// data or any stock–Kalshi result, so the default can't be chosen by outcome.
//
//   pnpm exec tsx --env-file-if-exists=.env.local --conditions=react-server scripts/measure-windows.ts
//
// For every open KXFEDDECISION event (E, in bp) and each of its outcome markets (probability, in
// pp), at each top of the hour from 10 AM to 4 PM New York on weekdays (the hourly rows' times,
// without the stock), it takes the change from the previous hour of the same session, and reports
// Kish's effective number of moves in the last 90, 180, and 365 days: 1/Σw² with w = x̌²/Σx̌²,
// x̌ the change net of its mean, as fragility.ts measures the primary test's window. Prints
// tickers and counts only, never a price or an E value.

import { neon } from "@neondatabase/serverless";
import { effectiveCount } from "@/lib/analytics/fragility";
import { expectedAt, LOOKBACK_MS, Outcome } from "@/lib/expected/engine";
import { storedOutcome } from "@/lib/expected/history";
import { mapEvent } from "@/lib/expected/mapping";
import { readStoredHistory, readStoredOutcomes } from "@/lib/expected/store";
import { readStoredKalshiWindow } from "@/lib/history/kalshi";
import { candlePoints } from "@/lib/history/merge";
import { timeZoneOffsetMs } from "@/lib/market-data/session";
import { httpSql } from "@/lib/store/sql";

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
const LONGEST = 540 * DAY_MS;
const WINDOWS = [90, 180, 365] as const;

/** Tops of the hour from 10 AM to 4 PM New York on weekdays in [from, to], with the New York date of each. */
function tradingMarks(from: number, to: number): { t: number; day: number }[] {
  const marks: { t: number; day: number }[] = [];
  for (let t = Math.ceil(from / HOUR_MS) * HOUR_MS; t <= to; t += HOUR_MS) {
    const local = new Date(t + timeZoneOffsetMs(t, "America/New_York"));
    const weekday = local.getUTCDay();
    const hour = local.getUTCHours();
    if (weekday === 0 || weekday === 6 || hour < 10 || hour > 16) continue;
    marks.push({ t, day: Math.floor(local.getTime() / DAY_MS) });
  }
  return marks;
}

/** Changes from the previous mark of the same session, where both ends have a value (and, for E, the same open outcomes). */
function changes(marks: { t: number; day: number }[], values: (number | null)[], keys?: string[]): { t: number; x: number }[] {
  const out: { t: number; x: number }[] = [];
  for (let i = 1; i < marks.length; i++) {
    if (marks[i].day !== marks[i - 1].day || marks[i].t - marks[i - 1].t !== HOUR_MS) continue;
    const [a, b] = [values[i - 1], values[i]];
    if (a === null || b === null || (keys && keys[i] !== keys[i - 1])) continue;
    out.push({ t: marks[i].t, x: b - a });
  }
  return out;
}

/** Kish's effective number of moves among the changes since `from`, or null if the history doesn't reach back that far. */
function effective(list: { t: number; x: number }[], from: number, start: number): number | null {
  if (start > from) return null;
  const xs = list.filter((c) => c.t > from).map((c) => c.x);
  if (xs.length === 0) return 0;
  const mean = xs.reduce((a, b) => a + b, 0) / xs.length;
  return effectiveCount(xs.map((x) => (x - mean) ** 2));
}

const median = (values: number[]) => {
  const s = [...values].sort((a, b) => a - b);
  return s.length === 0 ? null : (s[(s.length - 1) >> 1] + s[s.length >> 1]) / 2;
};
const fmt = (v: number | null) => (v === null ? "—" : v.toFixed(1));

async function main(): Promise<number> {
  const url = process.env.DATABASE_URL?.trim();
  if (!url) {
    console.error("DATABASE_URL isn't set. Set it in .env.local (the read-only eventlens_app role).");
    return 1;
  }
  const sql = httpSql(neon(url), { timeoutMs: 30_000 });
  const now = Date.now();
  const events = await sql.query<{ event_ticker: string }>(
    `select event_ticker from kalshi_markets where status = 'active' and series_ticker = 'KXFEDDECISION'
      group by event_ticker order by min(close_time)`,
    [],
  );

  const rows: { kind: "event" | "market"; ticker: string; days: number; eff: (number | null)[]; moves: number }[] = [];
  for (const { event_ticker: event } of events) {
    const stored = await readStoredOutcomes(sql, event);
    const open = Math.min(...stored.map((o) => o.openTime ?? Infinity));
    const start = Math.max(open, now - LONGEST);
    const marks = tradingMarks(start, now);
    const range = { from: start - LOOKBACK_MS, to: now };

    // The event's E.
    const mapping = mapEvent(stored.map((o) => o.raw), null);
    const history = await readStoredHistory(sql, event, range);
    const meta = new Map(stored.map((o) => [o.ticker, o]));
    const outcomes = mapping.outcomes.map((o) => {
      const m = meta.get(o.ticker)!;
      return new Outcome(storedOutcome({ ticker: o.ticker, value: o.value, openTime: m.openTime, closeTime: m.closeTime }, history));
    });
    const e = expectedAt(outcomes, marks.map((m) => m.t));
    const de = changes(marks, e.map((m) => m.value), e.map((m) => m.openSet.join(" ")));
    rows.push({ kind: "event", ticker: event, days: Math.round((now - open) / DAY_MS), eff: WINDOWS.map((w) => effective(de, now - w * DAY_MS, open)), moves: de.filter((c) => c.x !== 0).length });

    // Each open outcome's probability, in pp, read as Research reads one market (the midpoint in effect, else excluded).
    for (const o of stored.filter((m) => m.status === "active")) {
      const window = await readStoredKalshiWindow(sql, o.ticker, range);
      const points = candlePoints(window.candles);
      let k = -1;
      const values = marks.map(({ t }) => {
        while (k + 1 < points.length && points[k + 1].t <= t) k++;
        return k >= 0 && points[k].source === "midpoint" ? points[k].value * 100 : null;
      });
      const dp = changes(marks, values);
      const opened = o.openTime ?? open;
      rows.push({ kind: "market", ticker: o.ticker, days: Math.round((now - opened) / DAY_MS), eff: WINDOWS.map((w) => effective(dp, now - w * DAY_MS, opened)), moves: dp.filter((c) => c.x !== 0).length });
    }
  }

  console.log("kind    ticker                       days  eff90  eff180  eff365  moves");
  for (const r of rows) {
    console.log(`${r.kind.padEnd(7)} ${r.ticker.padEnd(28)} ${String(r.days).padStart(4)}  ${fmt(r.eff[0]).padStart(5)}  ${fmt(r.eff[1]).padStart(6)}  ${fmt(r.eff[2]).padStart(6)}  ${String(r.moves).padStart(5)}`);
  }
  for (const kind of ["event", "market"] as const) {
    const of = rows.filter((r) => r.kind === kind);
    console.log(`\n${of.length} open ${kind}s:`);
    for (const [i, w] of WINDOWS.entries()) {
      const full = of.filter((r) => r.eff[i] !== null);
      const m = median(full.map((r) => r.eff[i]!));
      const base = median(full.map((r) => r.eff[0]!));
      console.log(
        `  ${w} days: ${full.length} of ${of.length} have the whole window (${Math.round((100 * full.length) / of.length)}%); ` +
          `median effective moves ${fmt(m)}, against ${fmt(base)} at 90 days for the same ${kind}s (×${m !== null && base ? (m / base).toFixed(2) : "—"})`,
      );
    }
  }
  return 0;
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
