export interface DataError {
  code: string;
  message: string;
}

/** Outcome of a data fetch: either data or a user-presentable error. Never throws. */
export type Result<T> = { ok: true; data: T } | { ok: false; error: DataError };

export const ok = <T>(data: T): Result<T> => ({ ok: true, data });
export const fail = <T = never>(code: string, message: string): Result<T> => ({
  ok: false,
  error: { code, message },
});
