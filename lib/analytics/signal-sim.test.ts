import { describe, expect, it } from "vitest";
import { computeChanges } from "./changes";
import { fitMarketModel } from "./market-model";
import { abnormalAfter, SIGNAL_SIM, signalDataSet } from "./signal-sim";

// The signal simulations' data sets (signal-rates.sim.test.ts) are built as the README sets them.
// These seeds are outside the simulations' own.

const NY_HOUR = (t: number) => Number(new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", hour: "numeric", hourCycle: "h23" }).format(t));

describe("a signal simulation's data set", () => {
  const even = signalDataSet({ window: 21, seed: 4_242 });
  const odd = signalDataSet({ window: 21, seed: 4_243 });

  it("ends the window and the loaded rows at 1:00 PM New York of the last session, keeping the rest aside", () => {
    expect(NY_HOUR(even.windowRows.at(-1)!.t)).toBe(13);
    expect(even.full.at(-1)).toEqual(even.windowRows.at(-1));
    // The last session (31 March 2026) is on summer time, so the simulator's sessions run 11:00–17:00 New York.
    expect(even.after.map((r) => NY_HOUR(r.t))).toEqual([13, 14, 15, 16, 17]);
    // 62 sessions are loaded; the window holds the last 21, the last one cut at 1:00 PM.
    expect(even.full).toHaveLength(62 * 7 - 4);
    expect(even.windowRows).toHaveLength(21 * 7 - 4);
    expect(SIGNAL_SIM.endHour).toBe(13);
  });

  it("sets Kalshi's change in the hour ending at the window's end to 3 pp, up for even seeds and down for odd", () => {
    for (const [set, sign] of [
      [even, 1],
      [odd, -1],
    ] as const) {
      expect(set.jumpSign).toBe(sign);
      const last = computeChanges(set.windowRows, 100).changes.at(-1)!;
      expect(last.t).toBe(set.windowRows.at(-1)!.t);
      expect(last.kalshiChange).toBeCloseTo(sign * SIGNAL_SIM.jumpPp, 9);
    }
  });

  it("measures what came next as the abnormal return by the window's market model", () => {
    const model = fitMarketModel(even.full, even.closesByT)!;
    const [a, b, c] = even.after;
    const step = (x: typeof a, y: typeof a) => Math.log(y.stockClose / x.stockClose) - model.alpha - model.beta * Math.log(even.closesByT.get(y.t)! / even.closesByT.get(x.t)!);
    expect(abnormalAfter(even.after, even.closesByT, model, 1)).toBeCloseTo(step(a, b), 15);
    expect(abnormalAfter(even.after, even.closesByT, model, 2)).toBeCloseTo(step(a, b) + step(b, c), 15);
  });

  it("builds a lead into the stock only when asked", () => {
    const led = signalDataSet({ window: 21, seed: 4_242, lead: 0.3 });
    expect(led.windowRows.map((r) => r.kalshiValue)).toEqual(even.windowRows.map((r) => r.kalshiValue));
    expect(led.windowRows.map((r) => r.stockClose)).not.toEqual(even.windowRows.map((r) => r.stockClose));
  });
});
