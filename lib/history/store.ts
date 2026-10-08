import "server-only";

import { getAppSql } from "@/lib/store/db";
import type { Sql } from "@/lib/store/sql";

// The app's access to the data store. Without DATABASE_URL there is no store, and every caller
// fetches live exactly as before. A store that fails or is slow never fails a page: the read
// returns null and the caller goes live.

/** Whether the app has a data store (DATABASE_URL is set). */
export function storeOn(): boolean {
  return getAppSql() !== null;
}

/**
 * Why a read failed, in fixed words: a Postgres error code at most, never the driver's
 * message, which can name the host or quote the query.
 */
function reason(err: unknown): string {
  const names = [err, (err as { sourceError?: unknown } | null)?.sourceError].map((e) => (e instanceof Error ? e.name : ""));
  if (names.some((n) => n === "TimeoutError" || n === "AbortError")) return "timeout";
  const code = (err as { code?: unknown } | null)?.code;
  return typeof code === "string" && /^[0-9A-Z]{5}$/.test(code) ? `SQLSTATE ${code}` : "error";
}

/**
 * Runs `read` on the app's connection. Null without a store, or if the read fails or times out
 * (each query gives up after APP_QUERY_TIMEOUT_MS), which is logged in one fixed line.
 */
export async function readStore<T>(what: string, read: (sql: Sql) => Promise<T>): Promise<T | null> {
  const sql = getAppSql();
  if (!sql) return null;
  try {
    return await read(sql);
  } catch (err) {
    console.warn(`[store] ${what} unavailable (${reason(err)}); using live data`);
    return null;
  }
}
