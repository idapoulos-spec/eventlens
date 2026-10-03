// Seeded pseudo-random numbers, so every shuffle and bootstrap gives the same result each
// time the same data is analyzed.

/** A source of uniform numbers in [0, 1). */
export type Rng = () => number;

/** The seed every resampling method starts from. */
export const RESAMPLING_SEED = 20261003;

/**
 * mulberry32: a small 32-bit generator. Fast and well mixed enough for resampling; not for
 * cryptography. All arithmetic is 32-bit, so other languages can reproduce it exactly.
 */
export function mulberry32(seed: number): Rng {
  let state = seed | 0;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), state | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A generator seeded from RESAMPLING_SEED and a label (FNV-1a), so each method has its own stream. */
export function seededRng(label: string): Rng {
  let h = 0x811c9dc5 ^ RESAMPLING_SEED;
  for (let i = 0; i < label.length; i++) {
    h ^= label.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return mulberry32(h);
}
