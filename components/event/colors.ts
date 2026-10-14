// Colors for an event's outcomes, by what each is worth: a diverging scale, cuts on the blue arm,
// hikes on the red, no change neutral gray, and a lighter step for each larger move (on the dark
// surface, lighter stands out more). The blue steps are the reference sequential ramp's 450, 300,
// and 200; the red ones hold the red's hue at the same OKLCH lightness. Each arm passes the dataviz
// skill's ordinal checks on --surface (monotone lightness, steps ≥ 0.06 apart, ≥ 3:1 contrast).

const CUTS = ["#2a78d6", "#6da7ec", "#9ec5f4"];
const HIKES = ["#c7474b", "#e48482", "#f1aeaa"];
const HOLD = "#898781";

/** Each outcome's color, keyed by ticker: by its rank in size among outcomes on the same side of 0. */
export function outcomeColors(outcomes: { ticker: string; value: number }[]): Map<string, string> {
  const colors = new Map<string, string>();
  const side = (sign: number, ramp: string[]) =>
    outcomes
      .filter((o) => Math.sign(o.value) === sign)
      .sort((a, b) => Math.abs(a.value) - Math.abs(b.value))
      .forEach((o, i) => colors.set(o.ticker, ramp[Math.min(i, ramp.length - 1)]));
  side(-1, CUTS);
  side(1, HIKES);
  for (const o of outcomes) if (o.value === 0) colors.set(o.ticker, HOLD);
  return colors;
}
