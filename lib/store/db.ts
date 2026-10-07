import "server-only";

import { neon, Pool } from "@neondatabase/serverless";
import { httpSql, poolSql, type SessionSql, type Sql } from "./sql";

// Connections to the data store, one per Postgres role (see db/README.md). Each comes from its own
// environment variable and is null while that variable is unset, so the app runs exactly as it
// does without a store: locally, in worktrees, in CI builds, and on previews. Connection strings
// hold passwords, so they are never logged or put in an error message.

/** The app's reads give up after this long and fall back to the live APIs. */
export const APP_QUERY_TIMEOUT_MS = 2500;

function env(name: string): string | null {
  return process.env[name]?.trim() || null;
}

let app: { url: string; sql: Sql } | null = null;

/** The app's connection (`eventlens_app`, SELECT only) from DATABASE_URL, or null if it isn't set. */
export function getAppSql(): Sql | null {
  const url = env("DATABASE_URL");
  if (!url) return null;
  if (app?.url !== url) app = { url, sql: httpSql(neon(url), { timeoutMs: APP_QUERY_TIMEOUT_MS }) };
  return app.sql;
}

async function openSession(variable: string): Promise<SessionSql | null> {
  const url = env(variable);
  // One connection: scripts run their statements one after another.
  return url ? poolSql(new Pool({ connectionString: url, max: 1 })) : null;
}

/** A collector session (`eventlens_collector`) from COLLECTOR_DATABASE_URL, or null. Call `end()` when done. */
export function openCollectorSql(): Promise<SessionSql | null> {
  return openSession("COLLECTOR_DATABASE_URL");
}

/** An owner session from DATABASE_OWNER_URL, for migrations and the watchlist script only. Call `end()` when done. */
export function openOwnerSql(): Promise<SessionSql | null> {
  return openSession("DATABASE_OWNER_URL");
}
