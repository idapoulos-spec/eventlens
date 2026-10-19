// Computations written as steps (generators that yield between slices of work), so a page can
// spread them over several tasks and stay responsive; drained, they give the plain result.

/** Runs steps to the end and returns what they return. */
export function drain<T>(steps: Generator<unknown, T>): T {
  for (;;) {
    const r = steps.next();
    if (r.done) return r.value;
  }
}
