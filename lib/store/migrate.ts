// Creates the store's roles and applies db/migrations/*.sql in order. Run by scripts/migrate.ts
// with the owner's connection, and by the tests on PGlite. Never prints or returns a password.

import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import type { SessionSql, Sql } from "./sql";

export const APP_ROLE = "eventlens_app";
export const COLLECTOR_ROLE = "eventlens_collector";
export type StoreRole = typeof APP_ROLE | typeof COLLECTOR_ROLE;

/**
 * Letters, digits, `-` and `_` only, so a password can go in a SQL literal without escaping and
 * in a connection string without percent-encoding. 32 of them carry far more than the 60 bits
 * of entropy Neon requires.
 */
const PASSWORD = /^[A-Za-z0-9_-]{32,256}$/;
export const PASSWORD_RULE = "32 to 256 letters, digits, '-' or '_'";

/**
 * Settings each role starts every session with, so a query that runs away or a transaction left
 * open can't hold the database: the app falls back to live data well before 5 seconds.
 */
const ROLE_SETTINGS: Record<StoreRole, Record<string, string>> = {
  [APP_ROLE]: { timezone: "UTC", statement_timeout: "5s" },
  [COLLECTOR_ROLE]: { timezone: "UTC", statement_timeout: "60s", idle_in_transaction_session_timeout: "60s" },
};

export type RolePasswords = Record<StoreRole, string>;

const PASSWORD_VARS: Record<StoreRole, string> = {
  [APP_ROLE]: "DATABASE_APP_PASSWORD",
  [COLLECTOR_ROLE]: "DATABASE_COLLECTOR_PASSWORD",
};

/** Both role passwords from the environment, or what's wrong with them (variable names only, never values). */
export function readRolePasswords(
  env: Record<string, string | undefined>,
): { ok: true; passwords: RolePasswords } | { ok: false; problem: string } {
  const passwords = {} as RolePasswords;
  for (const [role, variable] of Object.entries(PASSWORD_VARS) as [StoreRole, string][]) {
    const value = env[variable]?.trim() ?? "";
    if (!value) return { ok: false, problem: `${variable} isn't set` };
    if (!PASSWORD.test(value)) return { ok: false, problem: `${variable} must be ${PASSWORD_RULE}` };
    passwords[role] = value;
  }
  if (passwords[APP_ROLE] === passwords[COLLECTOR_ROLE]) {
    return { ok: false, problem: `${PASSWORD_VARS[APP_ROLE]} and ${PASSWORD_VARS[COLLECTOR_ROLE]} must differ` };
  }
  return { ok: true, passwords };
}

export interface RoleChange {
  role: StoreRole;
  action: "created" | "updated";
}

/**
 * Creates both roles, or updates an existing role's password (so rerunning rotates passwords),
 * and sets each role's session defaults. Without passwords (tests), roles are created without
 * login and existing ones are left as they are.
 */
export async function ensureRoles(sql: Sql, passwords?: RolePasswords): Promise<RoleChange[]> {
  const changes: RoleChange[] = [];
  for (const role of [APP_ROLE, COLLECTOR_ROLE] as const) {
    const password = passwords?.[role];
    // Checked here too, since the password is written into the statement.
    if (password !== undefined && !PASSWORD.test(password)) throw new Error(`The ${role} password must be ${PASSWORD_RULE}.`);
    const login = password === undefined ? "nologin" : `login password '${password}'`;

    const [{ exists }] = await sql.query<{ exists: boolean }>("select exists (select from pg_roles where rolname = $1)", [role]);
    if (!exists) {
      await sql.query(`create role ${role} ${login}`);
      changes.push({ role, action: "created" });
    } else if (password !== undefined) {
      await sql.query(`alter role ${role} ${login}`);
      changes.push({ role, action: "updated" });
    }
    for (const [setting, value] of Object.entries(ROLE_SETTINGS[role])) {
      await sql.query(`alter role ${role} set ${setting} = '${value}'`);
    }
  }
  return changes;
}

export interface Migration {
  /** File name, e.g. 0001_init.sql. Applied in name order. */
  name: string;
  sql: string;
}

const MIGRATION_NAME = /^\d{4}_[a-z0-9_]+\.sql$/;
const MIGRATIONS_DIR = fileURLToPath(new URL("../../db/migrations/", import.meta.url));

/** Every migration in db/migrations, in the order to apply them. */
export async function loadMigrations(dir = MIGRATIONS_DIR): Promise<Migration[]> {
  const names = (await readdir(dir)).filter((name) => MIGRATION_NAME.test(name)).sort();
  return Promise.all(names.map(async (name) => ({ name, sql: await readFile(`${dir}/${name}`, "utf8") })));
}

/**
 * Applies the migrations not applied yet, each in its own transaction together with its row in
 * schema_migrations, so a failed migration leaves nothing behind. Returns the names applied.
 */
export async function applyMigrations(sql: SessionSql, migrations: Migration[]): Promise<string[]> {
  await sql.exec(
    "create table if not exists schema_migrations (name text primary key, applied_at timestamptz not null default now())",
  );
  const done = new Set((await sql.query<{ name: string }>("select name from schema_migrations")).map((r) => r.name));

  const applied: string[] = [];
  for (const migration of [...migrations].sort((a, b) => a.name.localeCompare(b.name))) {
    if (done.has(migration.name)) continue;
    if (!MIGRATION_NAME.test(migration.name)) throw new Error(`Migration names look like 0001_name.sql, not "${migration.name}".`);
    await sql.transaction(async (tx) => {
      await tx.exec(migration.sql);
      await tx.query("insert into schema_migrations (name) values ($1)", [migration.name]);
    });
    applied.push(migration.name);
  }
  return applied;
}
