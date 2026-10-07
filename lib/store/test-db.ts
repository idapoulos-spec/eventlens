// A fresh store in memory for tests: real Postgres (PGlite) with the roles and every migration
// applied, so tests run the same SQL as Neon without a network or a server.

import { PGlite } from "@electric-sql/pglite";
import { applyMigrations, ensureRoles, loadMigrations, type StoreRole } from "./migrate";
import { pgliteSql, type SessionSql } from "./sql";

export interface TestDb {
  /** The owner's session (PGlite's superuser). */
  sql: SessionSql;
  /** Runs `fn` as `role`, as Neon would for that role's connection, then switches back. */
  asRole<T>(role: StoreRole, fn: (sql: SessionSql) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

export async function createTestDb(): Promise<TestDb> {
  const sql = pgliteSql(await PGlite.create());
  await ensureRoles(sql);
  await applyMigrations(sql, await loadMigrations());
  return {
    sql,
    async asRole(role, fn) {
      await sql.exec(`set role ${role}`);
      try {
        return await fn(sql);
      } finally {
        await sql.exec("reset role");
      }
    },
    close: () => sql.end(),
  };
}
