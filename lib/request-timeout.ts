/** Every upstream API request gives up after this long. */
export const REQUEST_TIMEOUT_MS = 6000;

/** Abort signal for one upstream request. */
export const timeoutSignal = () => AbortSignal.timeout(REQUEST_TIMEOUT_MS);

/** True if a fetch failed because it hit the timeout. */
export function isTimeout(err: unknown): boolean {
  return (err as { name?: unknown } | null)?.name === "TimeoutError";
}
