// Times a scan's computation, so the scan page can be kept responsive. Pure computation on
// simulated candidates at realistic sizes (no network, no data):
//   pnpm exec tsx scripts/bench-scan.ts
// The page computes each candidate in steps (the first test is one step; a finer p is 1,000 draws a
// step; leave-one-out one rerun a step) and hands the main thread back between them, so what
// matters is the total and the longest single step. Figures in milliseconds, on this machine, one
// run each (no warm-up beyond the first candidate): the numbers are for sizing, not for quoting as rates.

import { lastSessions, simulateMarketRows } from "@/lib/analytics/test-helpers";
import { leaveOneOutTargets, rankScan, scanCandidateSteps, scanLeaveOneOutSteps, correctScan, type ScanInput, type ScanTest } from "@/lib/analytics/scan";
import { simulateScan } from "@/lib/analytics/scan-sim";

/** Runs a generator to the end, timing each step. */
function stepped<T>(gen: Generator<void, T>): { value: T; total: number; longest: number } {
  let total = 0;
  let longest = 0;
  for (;;) {
    const start = performance.now();
    const r = gen.next();
    const ms = performance.now() - start;
    total += ms;
    longest = Math.max(longest, ms);
    if (r.done) return { value: r.value, total, longest };
  }
}

/** Hourly candidates on one stock (scan-sim's independent design), the window the last `window` of `sessions`. */
function hourly(candidates: number, sessions: number, window: number, seed: number): ScanInput[] {
  const { inputs } = simulateScan({ candidates, structure: "independent", seed, sessions });
  return inputs.map((input) => ({ ...input, from: lastSessions(input.full, window, "hourly")[0].t - 1 }));
}

/** Daily candidates: one simulated market per candidate (timing only). */
function daily(candidates: number, sessions: number, window: number, seed: number): ScanInput[] {
  return Array.from({ length: candidates }, (_, k) => {
    const { rows, closesByT } = simulateMarketRows({ sessions, resolution: "daily", seed: seed + k, sharedVolatility: true, kalshiInMarket: 0.1 });
    return { full: rows, from: lastSessions(rows, window, "daily")[0].t - 1, resolution: "daily", scale: 100, closes: [...closesByT].map(([t, value]) => ({ t, value })) };
  });
}

const SETTINGS: [label: string, make: (k: number) => ScanInput[]][] = [
  ["90D hourly", (k) => hourly(k, 62, 62, 7)],
  ["30D hourly", (k) => hourly(k, 62, 21, 7)],
  ["1Y hourly", (k) => hourly(k, 252, 252, 7)],
  ["90D daily", (k) => daily(k, 62, 62, 7)],
];

const out: Record<string, string | number>[] = [];
for (const [label, make] of SETTINGS) {
  for (const k of [10, 30, 100]) {
    const inputs = make(k);
    let compute = 0;
    let longest = 0;
    let refined = 0;
    const tests: ScanTest[] = [];
    for (const input of inputs) {
      const r = stepped(scanCandidateSteps(input));
      compute += r.total;
      longest = Math.max(longest, r.longest);
      if (r.value.refined) refined++;
      tests.push(r.value);
    }
    const corrections = correctScan(tests.map((t) => t.p));
    const order = rankScan(tests.map((t, i) => ({ p: t.p, firstP: t.primary?.p ?? null, key: String(i) })));
    const targets = leaveOneOutTargets(order, (i) => tests[i].p !== null, (i) => corrections[i].survivesHolm || corrections[i].survivesBh);
    let loo = 0;
    let looLongest = 0;
    for (const i of targets) {
      const r = stepped(scanLeaveOneOutSteps(inputs[i], tests[i]));
      loo += r.total;
      looLongest = Math.max(looLongest, r.longest);
    }
    out.push({
      setting: label,
      candidates: k,
      refined,
      "compute total": Math.round(compute),
      "per candidate": Math.round(compute / k),
      "longest step": Math.round(longest),
      "leave-one-out total": Math.round(loo),
      "leave-one-out longest step": Math.round(looLongest),
    });
  }
}
console.table(out);
