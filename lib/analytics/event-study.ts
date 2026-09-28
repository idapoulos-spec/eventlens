import type { ChangePoint } from "./changes";
import type { ResearchRow } from "./research";
import { SMALL_EVENT_COUNT, sampleFlag, type SampleFlag } from "./sample";

// A 2 pp move computed from two midpoints can land a hair under 2 in floating point.
const EPSILON = 1e-9;

export interface EventStudyOptions {
  /** Smallest Kalshi probability change, in percentage points, that counts as a jump. */
  thresholdPp: number;
  /** Bars shown before the jump. */
  before: number;
  /** Bars shown after the jump; a jump this close to the previous one is skipped. */
  after: number;
}

export interface EventGroup {
  /** Average stock path at each offset, in percent, or null with no events. */
  mean: number[] | null;
  n: number;
  /** When each counted jump ended, and its size in pp. */
  events: { t: number; probChangePp: number }[];
  flag: SampleFlag;
}

export interface EventStudy {
  /** Bars relative to the jump: −before…after. The jump happens during bar 0. */
  offsets: number[];
  /** Jumps where the probability rose by at least the threshold. */
  rises: EventGroup;
  /** Jumps where the probability fell by at least the threshold. */
  falls: EventGroup;
  /**
   * The same path averaged over every window of the same length in the rows, jump or
   * not: the stock's normal drift, to compare the jump paths with.
   */
  baseline: { mean: number[] | null; n: number };
  /** Jumps at or above the threshold, before any were skipped. */
  detected: number;
  /** Jumps skipped because they came within `after` bars of an earlier counted jump. */
  skippedOverlap: number;
  /** Jumps skipped because the data doesn't reach `before` bars before or `after` bars after them. */
  skippedEdge: number;
}

function meanPath(paths: number[][]): number[] | null {
  if (paths.length === 0) return null;
  return paths[0].map((_, k) => paths.reduce((sum, p) => sum + p[k], 0) / paths.length);
}

function group(paths: number[][], events: EventGroup["events"]): EventGroup {
  return { mean: meanPath(paths), n: paths.length, events, flag: sampleFlag(paths.length, 1, SMALL_EVENT_COUNT) };
}

/**
 * The stock's average cumulative log return, in percent, in the bars around Kalshi jumps.
 * For a jump during bar i (the interval ending at row i), the path at offset k is
 * ln(S[i+k] / S[i−1]) · 100: zero at the close just before the jump, so bar 0 is the
 * jump interval itself, negative offsets show the run-up, and positive ones what followed.
 * Offsets count rows (bars), so a window can span a night or weekend between sessions.
 */
export function eventStudy(rows: ResearchRow[], changes: ChangePoint[], options: EventStudyOptions): EventStudy {
  const { thresholdPp, before, after } = options;
  const offsets = Array.from({ length: before + after + 1 }, (_, i) => i - before);
  const index = new Map(rows.map((r, i) => [r.t, i]));
  const hasWindow = (i: number) => i - before >= 0 && i >= 1 && i + after < rows.length;
  const path = (i: number) => offsets.map((k) => Math.log(rows[i + k].stockClose / rows[i - 1].stockClose) * 100);

  const jumps = changes.filter((c) => Math.abs(c.probChangePp) >= thresholdPp - EPSILON).sort((a, b) => a.t - b.t);
  const rises: number[][] = [];
  const falls: number[][] = [];
  const riseEvents: EventGroup["events"] = [];
  const fallEvents: EventGroup["events"] = [];
  let skippedOverlap = 0;
  let skippedEdge = 0;
  let lastKept = -Infinity;

  for (const jump of jumps) {
    const i = index.get(jump.t);
    if (i === undefined) continue;
    if (i - lastKept <= after) {
      skippedOverlap++;
    } else if (!hasWindow(i)) {
      skippedEdge++;
    } else {
      lastKept = i;
      const event = { t: jump.t, probChangePp: jump.probChangePp };
      if (jump.probChangePp > 0) {
        rises.push(path(i));
        riseEvents.push(event);
      } else {
        falls.push(path(i));
        fallEvents.push(event);
      }
    }
  }

  // Anchor the baseline where a jump could be: after a regular interval, one grid slot long.
  const baseline: number[][] = [];
  for (let i = 1; i < rows.length; i++) {
    if (hasWindow(i) && rows[i].step - rows[i - 1].step === 1) baseline.push(path(i));
  }

  return {
    offsets,
    rises: group(rises, riseEvents),
    falls: group(falls, fallEvents),
    baseline: { mean: meanPath(baseline), n: baseline.length },
    detected: jumps.length,
    skippedOverlap,
    skippedEdge,
  };
}
