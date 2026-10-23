import { describe, expect, it } from "vitest";
import { computeChanges } from "./changes";
import { primaryFrame } from "./correlation-test";
import { adjustedChanges, benchmarkReturnsByT, fitMarketModel } from "./market-model";
import { benjaminiHochberg, holm } from "./multiple-testing";
import { panelCore, secondaryLeaveOneOut, type PanelInput } from "./panel";
import { mulberry32, seededRng } from "./random";
import { rowsSince } from "./research";
import {
  correctScan,
  leaveOneOutTargets,
  rankScan,
  refineSteps,
  SCAN_LOO_MAX,
  SCAN_LOO_TOP,
  SCAN_REFINE_BELOW,
  scanCandidateSteps,
  scanLeaveOneOutSteps,
  type ScanInput,
} from "./scan";
import { drain } from "./steps";
import { lastSessions, simulateMarketRows } from "./test-helpers";
import { drawWeights, wildDraws, wildP } from "./wild-bootstrap";

/** A candidate as the panel computes a window: the market model on `sessions` loaded, the window the last `window` of them. */
function input({ sessions, window, resolution, seed, effect = 0 }: { sessions: number; window: number; resolution: "hourly" | "daily"; seed: number; effect?: number }): ScanInput {
  const { rows, closesByT } = simulateMarketRows({ sessions, resolution, seed, effect, sharedVolatility: true, kalshiInMarket: 0.1 });
  const last = lastSessions(rows, window, resolution);
  return { full: rows, from: last[0].t - 1, resolution, scale: 100, closes: [...closesByT].map(([t, value]) => ({ t, value })) };
}

const panelInput = (i: ScanInput): PanelInput => ({ ...i, returns: "adjusted" });

describe("scanCandidateSteps", () => {
  // 7, 30 and 90 days on 62 loaded sessions (the market model on all of them), and a long window
  // fitted on itself, hourly and daily.
  const cases = [
    { sessions: 62, window: 5, resolution: "hourly" as const },
    { sessions: 62, window: 21, resolution: "hourly" as const },
    { sessions: 62, window: 62, resolution: "hourly" as const },
    { sessions: 124, window: 124, resolution: "hourly" as const },
    { sessions: 62, window: 21, resolution: "daily" as const },
    { sessions: 62, window: 62, resolution: "daily" as const },
    { sessions: 124, window: 124, resolution: "daily" as const },
  ];

  for (const c of cases) {
    it(`gives the panel's own primary test and fragility (${c.resolution}, ${c.window} of ${c.sessions})`, () => {
      const i = input({ ...c, seed: 4_100 + c.window + c.sessions });
      const scan = drain(scanCandidateSteps(i));
      const core = panelCore(panelInput(i), { lags: false });
      expect(scan.primary).toEqual(core.market!.primary);
      expect(scan.fragility).toEqual(core.fragility);
      expect(scan.p).toBe(scan.refined ? scan.refined.p : scan.primary!.p);
    });
  }

  it("gives no p-value where the page gives none (fewer than 8 sessions in the window)", () => {
    const i = input({ sessions: 62, window: 5, resolution: "hourly", seed: 4_200 });
    const scan = drain(scanCandidateSteps(i));
    expect(scan.primary!.pUnavailable).toBe("too_few_blocks");
    expect(scan).toMatchObject({ p: null, refined: null, fragility: null });
  });

  it("refines exactly the candidates whose first p is under the cutoff", () => {
    let refined = 0;
    let kept = 0;
    for (let k = 0; k < 6; k++) {
      const scan = drain(scanCandidateSteps(input({ sessions: 62, window: 62, resolution: "daily", seed: 4_300 + k, effect: k % 2 ? 1.5 : 0 })));
      if (scan.primary!.p! < SCAN_REFINE_BELOW) {
        refined++;
        expect(scan.refined).toMatchObject({ draws: 19_999, stopped: false });
        expect(scan.p).toBe(scan.refined!.p);
      } else {
        kept++;
        expect(scan.refined).toBeNull();
        expect(scan.p).toBe(scan.primary!.p);
      }
    }
    expect(refined).toBeGreaterThan(0);
    expect(kept).toBeGreaterThan(0);
  });
});

describe("refineSteps", () => {
  const i = input({ sessions: 62, window: 62, resolution: "hourly", seed: 4_400, effect: 0.2 });
  const full = i.full;
  const closesByT = new Map(i.closes.map((p) => [p.t, p.value]));
  const model = fitMarketModel(full, closesByT)!;
  const abnormal = adjustedChanges(computeChanges(rowsSince(full, i.from), 100).changes, benchmarkReturnsByT(full, closesByT), model);
  const { f } = primaryFrame(abnormal, "hourly", model.sample)!;
  const blocks = f.block.reduce((max, b) => Math.max(max, b + 1), 0);

  it("reproduces the primary test's p with its own 999 draws, so the frame and weights are the test's", () => {
    const scan = drain(scanCandidateSteps(i));
    expect(drain(refineSteps(f, { draws: 999, rng: seededRng("wild-bootstrap") })).p).toBe(scan.primary!.p);
  });

  it("gives the same p in chunks as drawing every weight at once", () => {
    const oneShot = wildP(f, wildDraws(f, drawWeights(blocks, 2_500, seededRng("scan-refine"))), 0);
    expect(drain(refineSteps(f, { draws: 2_500 })).p).toBe(oneShot);
  });

  it("stops early only past the bound, and the full p is never below what it reports", () => {
    const full = drain(refineSteps(f, { draws: 5_000 }));
    const stopped = drain(refineSteps(f, { draws: 5_000, stopAbove: full.p / 3 }));
    expect(stopped.stopped).toBe(true);
    expect(stopped.draws).toBeLessThan(5_000);
    expect(stopped.p).toBeGreaterThan(full.p / 3);
    expect(stopped.p).toBeLessThanOrEqual(full.p);
    expect(drain(refineSteps(f, { draws: 5_000, stopAbove: 0.99 }))).toEqual(full);
  });
});

describe("scanLeaveOneOutSteps", () => {
  it("is the leave-one-out check the candidate's own page runs", () => {
    const i = input({ sessions: 62, window: 62, resolution: "daily", seed: 4_500, effect: 1 });
    const scan = drain(scanCandidateSteps(i));
    const core = panelCore(panelInput(i), { lags: false });
    expect(drain(scanLeaveOneOutSteps(i, scan))).toEqual(secondaryLeaveOneOut(panelInput(i), core));
  });
});

describe("correctScan", () => {
  it("is Holm and Benjamini–Hochberg over the finished candidates once nothing is pending", () => {
    const ps = [0.0004, null, 0.03, 0.2, 0.0011, null, 0.6];
    const c = correctScan(ps);
    expect(c.map((x) => x.holm)).toEqual(holm(ps));
    expect(c.map((x) => x.bh)).toEqual(benjaminiHochberg(ps));
    // m = 5: the untested candidates don't count.
    expect(c[0].holm).toBeCloseTo(0.002, 12);
    expect(c[0].survivesHolm && c[4].survivesHolm).toBe(true);
    expect(c[2].survivesHolm).toBe(false);
    expect(c[1]).toEqual({ holm: null, bh: null, survivesHolm: false, survivesBh: false });
  });

  it("shows upper bounds while candidates are pending, so no survivor is ever withdrawn", () => {
    const rng = mulberry32(4_600);
    for (let trial = 0; trial < 300; trial++) {
      const m = 2 + Math.floor(rng() * 40);
      // A mix of tiny, small, and null-like p-values, some untested, arriving in random order.
      const ps = Array.from({ length: m }, () => (rng() < 0.1 ? null : rng() < 0.3 ? rng() * 0.002 : rng()));
      const final = correctScan(ps);
      for (let done = 1; done < m; done++) {
        const now = correctScan(ps.slice(0, done), m - done);
        now.forEach((c, i) => {
          if (c.holm === null) return expect(final[i].holm).toBeNull();
          expect(final[i].holm!).toBeLessThanOrEqual(c.holm + 1e-15);
          expect(final[i].bh!).toBeLessThanOrEqual(c.bh! + 1e-15);
          if (c.survivesHolm) expect(final[i].survivesHolm).toBe(true);
          if (c.survivesBh) expect(final[i].survivesBh).toBe(true);
        });
      }
    }
  });
});

describe("rankScan and leaveOneOutTargets", () => {
  it("ranks by p, then the first p, then key, with untested candidates last", () => {
    const order = rankScan([
      { p: 0.2, firstP: 0.2, key: "A" },
      { p: null, firstP: null, key: "B" },
      { p: 0.00005, firstP: 0.001, key: "D" },
      { p: 0.00005, firstP: 0.001, key: "C" },
      { p: 0.00005, firstP: 0.002, key: "A2" },
      { p: 0.03, firstP: 0.03, key: "E" },
    ]);
    expect(order).toEqual([3, 2, 4, 5, 0, 1]);
  });

  it("picks the top five tested, then other survivors, at most ten", () => {
    const order = Array.from({ length: 20 }, (_, i) => i);
    const tested = (i: number) => i !== 1;
    expect(leaveOneOutTargets(order, tested, () => false)).toEqual([0, 2, 3, 4, 5]);
    expect(leaveOneOutTargets(order, tested, (i) => i === 9)).toEqual([0, 2, 3, 4, 5, 9]);
    expect(leaveOneOutTargets(order, tested, () => true)).toHaveLength(SCAN_LOO_MAX);
    expect(SCAN_LOO_TOP).toBe(5);
  });
});

describe("a scan end to end", () => {
  it("ranks a planted strong effect first among nine unrelated candidates, and it survives both corrections", () => {
    const candidates = Array.from({ length: 10 }, (_, k) => input({ sessions: 62, window: 62, resolution: "daily", seed: 4_700 + k, effect: k === 6 ? 2 : 0 }));
    const tests = candidates.map((c) => drain(scanCandidateSteps(c)));
    const correction = correctScan(tests.map((t) => t.p));
    const order = rankScan(tests.map((t, k) => ({ p: t.p, firstP: t.primary?.p ?? null, key: String(k) })));
    expect(order[0]).toBe(6);
    expect(correction[6]).toMatchObject({ survivesHolm: true, survivesBh: true });
    expect(tests[6].refined!.p).toBeLessThan(0.05 / 10);
  });
});
