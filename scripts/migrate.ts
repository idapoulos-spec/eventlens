// Creates the store's roles and applies db/migrations, as the database owner.
//
//   pnpm db:migrate
//
// Reads DATABASE_OWNER_URL, DATABASE_APP_PASSWORD, and DATABASE_COLLECTOR_PASSWORD from the
// environment (`.env.local` locally; see db/README.md). Prints role and migration names only,
// never a password or connection string. Safe to rerun: it applies only new migrations, and
// sets each role's password again, so changing a password in .env.local and rerunning rotates it.

import { openOwnerSql } from "@/lib/store/db";
import { applyMigrations, ensureRoles, loadMigrations, readRolePasswords } from "@/lib/store/migrate";

async function main(): Promise<number> {
  const passwords = readRolePasswords(process.env);
  if (!passwords.ok) {
    console.error(`[migrate] ${passwords.problem}. Set it in .env.local (see db/README.md).`);
    return 1;
  }
  const sql = await openOwnerSql();
  if (!sql) {
    console.error("[migrate] DATABASE_OWNER_URL isn't set. Set it in .env.local (see db/README.md).");
    return 1;
  }

  // Postgres errors can quote the statement they failed on, and role statements carry passwords.
  const redact = (text: string) =>
    Object.values(passwords.passwords).reduce((t, secret) => t.replaceAll(secret, "[redacted]"), text);
  try {
    for (const { role, action } of await ensureRoles(sql, passwords.passwords)) console.log(`[migrate] role ${role}: ${action}`);
    const applied = await applyMigrations(sql, await loadMigrations());
    console.log(applied.length ? `[migrate] applied ${applied.join(", ")}` : "[migrate] already up to date");
    return 0;
  } catch (err) {
    const code = (err as { code?: unknown }).code;
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[migrate] failed${typeof code === "string" ? ` (Postgres ${code})` : ""}: ${redact(message)}`);
    return 1;
  } finally {
    await sql.end();
  }
}

main().then((code) => {
  process.exitCode = code;
});
