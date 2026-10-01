import { describe, expect, it } from "vitest";
import { uncertaintyScore } from "@/lib/analytics";
import { uncertaintyLabel } from "./KalshiPanel";

const label = (p: number) => uncertaintyLabel(uncertaintyScore(p)!, p);

describe("uncertaintyLabel", () => {
  it("calls it a coin flip only from 40% to 60%, as the panel shows the probability", () => {
    for (const p of [0.4, 0.45, 0.5, 0.6, 0.39996, 0.60004]) expect(label(p)).toBe("High — close to a coin flip");
    expect(label(0.605)).toBe("High — leans YES, but far from certain");
    expect(label(0.395)).toBe("High — leans NO, but far from certain");
  });

  it("names the side a highly uncertain market leans to, without calling it a coin flip", () => {
    // Scores 87.5: high uncertainty, but the market clearly leans YES.
    expect(uncertaintyScore(0.705)).toBeGreaterThan(80);
    expect(label(0.705)).toBe("High — leans YES, but far from certain");
    expect(label(0.3)).toBe("High — leans NO, but far from certain");
  });

  it("keeps the score's tiers: high from 80, moderate from 40, low below", () => {
    expect(label(0.85)).toBe("Moderate — favors YES");
    expect(label(0.15)).toBe("Moderate — favors NO");
    expect(label(0.97)).toBe("Low — strongly favors YES");
    expect(label(0.02)).toBe("Low — strongly favors NO");
  });
});
