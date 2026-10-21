// Times what the Research panel computes for each window and toggle, so the page can be kept
// responsive. Pure computation on simulated rows at realistic sizes (no network, no data):
//   pnpm exec tsx scripts/bench-research.ts
// Figures are medians of 5 runs after a warm-up, in milliseconds, on this machine.
//
// 7, 30, and 90 days are computed on the page as a toggle happens (the "sync" columns); the
// longer windows, the detectable size, and the leave-one-out check run afterwards in slices, so
// what matters for them is the longest single step (how long the page can go without the main
// thread) as well as the total.

import { detectableCorrelation } from "@/lib/analytics/correlation-test";
import { panelCore, panelCoreSteps, panelEvents, secondaryLeaveOneOutSteps, type PanelInput } from "@/lib/analytics/panel";
import type { Resolution } from "@/lib/analytics/research";
import { lastSessions, simulateMarketRows } from "@/lib/analytics/test-helpers";

const RUNS = 5;
const median = (values: number[]) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];

function time(fn: () => unknown): number {
  fn();
  return median(Array.from({ length: RUNS }, () => {
    const start = performance.now();
    fn();
    return performance.now() - start;
  }));
}

/** Total and longest single step of a computation written as steps. */
function stepped(make: () => Generator<unknown, unknown>): { total: number; longest: number } {
  const runs = Array.from({ length: RUNS }, () => {
    const gen = make();
    let total = 0;
    let longest = 0;
    for (;;) {
      const start = performance.now();
      const r = gen.next();
      const ms = performance.now() - start;
      total += ms;
      longest = Math.max(longest, ms);
      if (r.done) break;
    }
    return { total, longest };
  });
  return { total: median(runs.map((r) => r.total)), longest: median(runs.map((r) => r.longest)) };
}

/** Sessions (hourly) or trading days (daily) in each window, and whether the market model is fitted on 90 days or the window. */
const WINDOWS: [label: string, sessions: number, loaded: number][] = [
  ["7D", 5, 62],
  ["30D", 21, 62],
  ["90D", 62, 62],
  ["180D", 124, 124],
  ["1Y", 252, 252],
  ["All (540 d)", 372, 372],
];

const out: Record<string, string | number>[] = [];
for (const resolution of ["hourly", "daily"] as Resolution[]) {
  for (const [label, sessions, loaded] of WINDOWS) {
    if (resolution === "daily" && sessions === 5) continue;
    const { rows, closesByT } = simulateMarketRows({ sessions: loaded, resolution, seed: 7, sharedVolatility: true, kalshiInMarket: 0.1 });
    const window = lastSessions(rows, sessions, resolution);
    const input: PanelInput = {
      full: rows,
      from: window[0].t - 1,
      resolution,
      scale: 100,
      closes: [...closesByT].map(([t, value]) => ({ t, value })),
      returns: "adjusted",
    };
    const threshold = resolution === "hourly" ? 1.5 : 3;
    const core = panelCore(input);
    const light = panelCore(input, { lags: false });
    const coreTime = time(() => panelCore(input));
    const eventsTime = time(() => panelEvents(input, core, threshold));
    const main = stepped(() => panelCoreSteps(input));
    const loo = stepped(() => secondaryLeaveOneOutSteps(input, light));
    out.push({
      resolution,
      window: label,
      intervals: core.series.changes.length,
      "window/benchmark/returns": Math.round(coreTime + eventsTime),
      "jump size": Math.round(eventsTime),
      "main: total": Math.round(main.total + eventsTime),
      "main: longest step": Math.round(Math.max(main.longest, eventsTime)),
      // Timed whatever the p-value (the page computes it only for a result that isn't significant).
      detectable: Math.round(time(() => light.market?.abnormal && light.market.model && detectableCorrelation(light.market.abnormal, resolution, { refit: light.market.model.sample }))),
      "leave-one-out: total": Math.round(loo.total),
      "leave-one-out: longest step": Math.round(loo.longest),
    });
  }
}

const columns = Object.keys(out[0]);
console.log(columns.join("\t"));
for (const r of out) console.log(columns.map((c) => r[c]).join("\t"));
