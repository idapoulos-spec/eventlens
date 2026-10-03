// Corrections for testing several hypotheses at once. A null p-value is a test that couldn't
// be run; it stays null and doesn't count toward the family size.

function ranked(ps: (number | null)[]): { p: number; i: number }[] {
  return ps.flatMap((p, i) => (p === null ? [] : [{ p, i }])).sort((a, b) => a.p - b.p || a.i - b.i);
}

/**
 * Holm's step-down adjusted p-values: an adjusted p below α keeps the chance of any false
 * positive in the family at most α, whatever the dependence between the tests.
 */
export function holm(ps: (number | null)[]): (number | null)[] {
  const order = ranked(ps);
  const m = order.length;
  const adjusted: (number | null)[] = ps.map(() => null);
  let running = 0;
  order.forEach(({ p, i }, rank) => {
    running = Math.max(running, Math.min(1, (m - rank) * p));
    adjusted[i] = running;
  });
  return adjusted;
}

/**
 * Benjamini–Hochberg adjusted p-values (q-values): rejecting those below α keeps the expected
 * share of false positives among the rejections at most α, for independent or positively
 * dependent tests.
 */
export function benjaminiHochberg(ps: (number | null)[]): (number | null)[] {
  const order = ranked(ps);
  const m = order.length;
  const adjusted: (number | null)[] = ps.map(() => null);
  let running = 1;
  for (let rank = m - 1; rank >= 0; rank--) {
    const { p, i } = order[rank];
    running = Math.min(running, (m * p) / (rank + 1));
    adjusted[i] = Math.min(1, running);
  }
  return adjusted;
}
