import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { FRAGILE } from "@/lib/analytics/fragility";
import { SIGNAL } from "@/lib/analytics/signal";
import { SIGNAL_SIM } from "@/lib/analytics/signal-sim";
import { numbersIn } from "../report/test-helpers";
import { signalInput, signalScenarios, SIGNAL_PATHS } from "./scenarios";
import { DECIDED, HOLD, leanLabel, SIGNAL_RULE_NUMBERS, SIGNAL_SIMULATIONS } from "./signal";
import { bottomLine, METER_STEP } from "./summary";

// The experimental signal's words (signal.ts): what each path says, that it never claims more than the
// badge, and that its rules quote only their own constants and the simulations' committed figures.

const scenarios = signalScenarios();
const at = (path: keyof typeof SIGNAL_PATHS, over = {}) => bottomLine(signalInput(path, over)).signal!;

describe("the signal's words", () => {
  it("names the page's benchmark in a lean, and its level beside it", () => {
    expect(at("signal: leans up")).toMatchObject({ label: "buy", text: "Leans Buy vs. SPY", levelText: "Moderate evidence" });
    expect(at("signal: leans down, Kalshi falling")).toMatchObject({ label: "sell", text: "Leans Sell vs. SPY" });
    expect(at("signal: leans down, opposite lead")).toMatchObject({ label: "sell", text: "Leans Sell vs. SPY", levelText: "Moderate evidence" });
    expect(at("signal: leans up", { benchmark: "QQQ" }).text).toBe(leanLabel("buy", "QQQ"));
  });

  it("says what a lean means here: the move, and which way the stock tended to go against the benchmark", () => {
    expect(at("signal: leans up").reason).toBe("Kalshi rose 3.0 points in the last 2 hours. In this window, TLT tended to rise against SPY in the 2 hours after moves like that.");
    expect(at("signal: leans down, opposite lead").reason).toBe("Kalshi rose 3.0 points in the last 2 hours. In this window, TLT tended to fall against SPY in the 2 hours after moves like that.");
    expect(at("signal: leans, small lead").reason).toContain("The lead is small: Kalshi’s moves explain only a tiny part of TLT’s later moves.");
  });

  it("gives each hold its reason", () => {
    expect(at("signal: Kalshi doesn't move first")).toMatchObject({ text: HOLD, levelText: "No clear lead", reason: "Kalshi doesn’t move first: no time shift with Kalshi first passed the corrected test." });
    expect(at("signal: both ways").reason).toBe("Time shifts passed both ways, so it can’t tell which moves first.");
    expect(at("signal: fragile lead (F3)").reason).toBe("Kalshi moving first is fragile, so the evidence is Weak. Leaving out one of the 10 trading days that mattered most changed it in 2 of 10 tries.");
    expect(at("signal: badge Weak").reason).toBe("The signal is never stronger than the rating above, which is Weak.");
    expect(at("signal: too late in the day").reason).toBe("Too late in the trading day: a 2-hour lead can’t play out before the 4 PM close.");
    expect(at("signal: no recent move").reason).toBe("No Kalshi move of 2 points or more in the 2 hours that a 2-hour lead can still play out today.");
    expect(at("signal: no recent move", { resolution: "daily" }).reason).toBe("No Kalshi move of 2 points or more in the last 2 trading days.");
    expect(at("signal: checking the lead")).toMatchObject({ text: "Checking…", levelText: "", label: "pending" });
  });

  it("shows four chips: who moves first, stability, the recent move, and the data", () => {
    expect(at("signal: leans up").chips).toEqual([
      { id: "first", label: "Kalshi moves first", value: "Yes, by 2 hrs" },
      { id: "stability", label: "Stability", value: "Stable" },
      { id: "move", label: "Recent Kalshi move", value: "+3.0 pts in 2 hrs" },
      expect.objectContaining({ id: "data", label: "Data" }),
    ]);
    expect(at("signal: leans up", { variable: { ...signalInput("signal: leans up").variable, kind: "expected", unit: "bp" } }).chips[2].label).toBe("Recent move");
    expect(at("signal: fragile lead (F1)").chips[1].value).toBe("Fragile");
    expect(at("signal: too late in the day").chips[2].value).toBe("Too late today");
    expect(at("signal: Kalshi doesn't move first").chips.map((c) => c.value).slice(0, 3)).toEqual(["No", "—", "—"]);
  });

  it("never leans above the card's badge, nor below Moderate", () => {
    let leans = 0;
    for (const s of scenarios) {
      const { label, level } = s.summary.signal!;
      if (label !== "buy" && label !== "sell") continue;
      leans++;
      expect(["moderate", "strong"], s.name).toContain(level);
      expect(METER_STEP[level as "moderate"]!, s.name).toBeLessThanOrEqual(METER_STEP[s.summary.level]!);
    }
    expect(leans).toBeGreaterThan(50);
    expect(at("signal: leans, strong lead capped at the badge").levelText).toBe("Moderate evidence");
    expect(at("signal: leans, strong").levelText).toBe("Strong evidence");
  });

  it("says how it's decided in one sentence", () => {
    expect(DECIDED).toBe("Kalshi must move first in a stable, corrected test rated Moderate or better, and have just moved by the jump size.");
  });
});

describe("the signal's rules", () => {
  it("quote only their own constants and the simulations' figures, each from its source", () => {
    const rules = at("signal: leans up").rules.join(" ");
    expect(new Set(numbersIn(rules))).toEqual(new Set(numbersIn(SIGNAL_RULE_NUMBERS.join(" "))));
    expect(SIGNAL_RULE_NUMBERS.slice(0, 3)).toEqual([String(FRAGILE.leaveOut), String(SIGNAL.closeHour - 12), String(SIGNAL_SIM.jumpPp)]);
    // The simulations' figures are the README's, from the single committed run.
    const readme = readFileSync("README.md", "utf8");
    for (const row of ["| 30 days | 99.2% (496) | 0% (0) | 0.6% (3) | 0.2% (1) | 0% (0), range 0–0.8% |", "| 90 days | 98.4% (492)", "| 180 days | 97.0% (485)"]) expect(readme).toContain(row);
    expect(readme).toContain("| Kalshi first and the same hour | 90 days | 5% (5) | 19% (19) | 15% (15) | 9% (9) | 52.0% (52) ± 5.0, range 42.3–61.5% | 100% (52 of 52)");
    expect(readme).toContain("| Kalshi first only | 90 days | 11% (11) | 3% (3) | 20% (20) | 63% (63) | 3.0% (3) ± 1.7");
    expect(SIGNAL_SIMULATIONS.join(" ")).toContain("0 of 500 at 30, 90, and 180 days each");
    expect(SIGNAL_SIMULATIONS.join(" ")).toContain("52 of 100 leaned at 90 days, all the right way. With a lead alone, 3 of 100 did.");
  });
});
