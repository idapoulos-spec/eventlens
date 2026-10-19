import { describe, expect, it } from "vitest";
import { panelCore, panelEvents, panelResults, secondaryDetectable, secondaryLeaveOneOut, type PanelInput } from "./panel";
import { panelRunner, runJob, type PanelMessage } from "./panel-jobs";
import { simulateMarketRows } from "./test-helpers";

// A window of 20 sessions: the jobs, run a step at a time, give exactly what the page computes directly.
const { rows, closesByT } = simulateMarketRows({ sessions: 20, resolution: "hourly", seed: 905, sharedVolatility: true, kalshiInMarket: 0.1 });
const input: PanelInput = {
  full: rows,
  from: -Infinity,
  resolution: "hourly",
  scale: 100,
  closes: [...closesByT].map(([t, value]) => ({ t, value })),
  returns: "adjusted",
};

describe("panelRunner", () => {
  it("posts the main results, then the detectable size and leave-one-out check, as computed directly", () => {
    const run = panelRunner();
    const messages: PanelMessage[] = [];
    runJob(run, { kind: "main", key: "a", coreKey: "core", input, threshold: 1.5 }, (m) => messages.push(m));
    runJob(run, { kind: "secondary", key: "a", coreKey: "core", input }, (m) => messages.push(m));

    const core = panelCore(input);
    expect(messages.map((m) => [m.kind, m.key])).toEqual([
      ["main", "a"],
      ["detectable", "a"],
      ["leave_one_out", "a"],
    ]);
    expect(messages[0].value).toEqual(panelResults(core, panelEvents(input, core, 1.5)));
    expect(messages[1].value).toEqual(secondaryDetectable(core, "hourly"));
    expect(messages[2].value).toEqual(secondaryLeaveOneOut(input, core));
    expect(messages[2].value).not.toBeNull();
    expect(messages.every((m) => m.ms >= 0)).toBe(true);
  });

  it("gives the same results for another jump size, with the core reused or not", () => {
    const run = panelRunner();
    const post = (m: PanelMessage) => m;
    runJob(run, { kind: "main", key: "a", coreKey: "core", input, threshold: 1.5 }, post);
    let reused: PanelMessage | undefined;
    runJob(run, { kind: "main", key: "b", coreKey: "core", input, threshold: 3 }, (m) => (reused = m));
    let fresh: PanelMessage | undefined;
    runJob(panelRunner(), { kind: "main", key: "b", coreKey: "core", input, threshold: 3 }, (m) => (fresh = m));
    expect(reused).toEqual({ ...fresh!, ms: reused!.ms });
  });

  it("recomputes the lead-lag tests when a secondary job left only a core without them", () => {
    const run = panelRunner();
    runJob(run, { kind: "secondary", key: "a", coreKey: "core", input }, () => {});
    let main: PanelMessage | undefined;
    runJob(run, { kind: "main", key: "a", coreKey: "core", input, threshold: 1.5 }, (m) => (main = m));
    expect(main?.kind === "main" && main.value.view.lags).toHaveLength(7);
  });

  it("pauses between every bootstrap, so a page can stay responsive while it runs", () => {
    const steps = [...panelRunner()({ kind: "main", key: "a", coreKey: "core", input, threshold: 1.5 })];
    // The primary test, the regression, the benchmark check, and each of 7 lags, at least.
    expect(steps.filter((s) => s === null).length).toBeGreaterThanOrEqual(10);
    const loo = [...panelRunner()({ kind: "secondary", key: "a", coreKey: "core", input })];
    // And each of the 10 leave-one-out reruns.
    expect(loo.filter((s) => s === null).length).toBeGreaterThanOrEqual(12);
  });
});
