/**
 * Binary (Shannon) entropy in bits for a probability p in [0, 1].
 * Maximum of 1 bit at p = 0.5, zero at p = 0 or p = 1.
 */
export function binaryEntropy(p: number): number {
  if (!Number.isFinite(p) || p <= 0 || p >= 1) return 0;
  return -(p * Math.log2(p) + (1 - p) * Math.log2(1 - p));
}

/** Event uncertainty on a 0–100 scale: 100 at a coin flip, 0 at certainty. */
export function uncertaintyScore(p: number | null): number | null {
  if (p === null) return null;
  return binaryEntropy(p) * 100;
}
