import { PGlite } from "@electric-sql/pglite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  APP_ROLE,
  applyMigrations,
  COLLECTOR_ROLE,
  ensureRoles,
  loadMigrations,
  readRolePasswords,
  type RolePasswords,
} from "./migrate";
import { pgliteSql, type SessionSql } from "./sql";
import { createTestDb, type TestDb } from "./test-db";

const APP_PW = "a".repeat(16) + "B".repeat(16);
const COLLECTOR_PW = "c-".repeat(16) + "_9";

describe("readRolePasswords", () => {
  const env = { DATABASE_APP_PASSWORD: APP_PW, DATABASE_COLLECTOR_PASSWORD: COLLECTOR_PW };

  it("reads both passwords", () => {
    expect(readRolePasswords(env)).toEqual({ ok: true, passwords: { [APP_ROLE]: APP_PW, [COLLECTOR_ROLE]: COLLECTOR_PW } });
  });

  it("names the variable that's wrong, never its value", () => {
    expect(readRolePasswords({ ...env, DATABASE_APP_PASSWORD: "" })).toEqual({
      ok: false,
      problem: "DATABASE_APP_PASSWORD isn't set",
    });
    for (const bad of ["short", `${"x".repeat(32)}'`, `${"x".repeat(32)} y`, `${"x".repeat(32)}$`, "x".repeat(257)]) {
      const result = readRolePasswords({ ...env, DATABASE_COLLECTOR_PASSWORD: bad });
      expect(result.ok).toBe(false);
      expect(JSON.stringify(result)).not.toContain(bad);
    }
    expect(readRolePasswords({ ...env, DATABASE_COLLECTOR_PASSWORD: APP_PW })).toEqual({
      ok: false,
      problem: "DATABASE_APP_PASSWORD and DATABASE_COLLECTOR_PASSWORD must differ",
    });
  });
});

describe("ensureRoles and applyMigrations", () => {
  let sql: SessionSql;

  beforeEach(async () => {
    sql = pgliteSql(await PGlite.create());
  });
  afterEach(() => sql.end());

  const passwords: RolePasswords = { [APP_ROLE]: APP_PW, [COLLECTOR_ROLE]: COLLECTOR_PW };

  it("creates the roles with login, then updates their passwords on a rerun", async () => {
    expect(await ensureRoles(sql, passwords)).toEqual([
      { role: APP_ROLE, action: "created" },
      { role: COLLECTOR_ROLE, action: "created" },
    ]);
    expect(await ensureRoles(sql, passwords)).toEqual([
      { role: APP_ROLE, action: "updated" },
      { role: COLLECTOR_ROLE, action: "updated" },
    ]);
    const roles = await sql.query<{ rolname: string; rolcanlogin: boolean; rolsuper: boolean; rolconfig: string[] }>(
      "select rolname, rolcanlogin, rolsuper, rolconfig from pg_roles where rolname like 'eventlens_%' order by rolname",
    );
    expect(roles).toEqual([
      { rolname: APP_ROLE, rolcanlogin: true, rolsuper: false, rolconfig: ["TimeZone=UTC", "statement_timeout=5s"] },
      {
        rolname: COLLECTOR_ROLE,
        rolcanlogin: true,
        rolsuper: false,
        rolconfig: ["TimeZone=UTC", "statement_timeout=60s", "idle_in_transaction_session_timeout=60s"],
      },
    ]);
  });

  it("refuses a password that would need quoting, before running any SQL", async () => {
    await expect(ensureRoles(sql, { ...passwords, [APP_ROLE]: `${"x".repeat(32)}'; drop table t; --` })).rejects.toThrow(
      /eventlens_app password must be/,
    );
    expect(await sql.query("select from pg_roles where rolname like 'eventlens_%'")).toHaveLength(0);
  });

  it("applies each migration once", async () => {
    await ensureRoles(sql);
    const migrations = await loadMigrations();
    expect(migrations.map((m) => m.name)).toContain("0001_init.sql");
    expect(await applyMigrations(sql, migrations)).toEqual(migrations.map((m) => m.name));
    expect(await applyMigrations(sql, migrations)).toEqual([]);
  });

  it("leaves nothing behind when a migration fails", async () => {
    await ensureRoles(sql);
    await expect(
      applyMigrations(sql, [{ name: "0001_broken.sql", sql: "create table half_done (id int); select * from no_such_table;" }]),
    ).rejects.toThrow(/no_such_table/);
    expect(await sql.query("select from pg_tables where tablename = 'half_done'")).toHaveLength(0);
    expect(await sql.query("select from schema_migrations")).toHaveLength(0);
  });

  it("rejects a migration file name out of pattern", async () => {
    await expect(applyMigrations(sql, [{ name: "init.sql", sql: "select 1" }])).rejects.toThrow(/0001_name.sql/);
  });
});

describe("the schema's privileges", () => {
  let db: TestDb;

  beforeEach(async () => {
    db = await createTestDb();
  });
  afterEach(() => db.close());

  const insertMarket = (sql: SessionSql) =>
    sql.query(
      `insert into kalshi_markets (ticker, event_ticker, series_ticker, status, source, raw)
       values ('KXTEST-26OCT-H0', 'KXTEST-26OCT', 'KXTEST', 'active', 'live', '{}') returning id`,
    );

  it("lets the app read every table and write none", async () => {
    await db.asRole(APP_ROLE, async (sql) => {
      expect(await sql.query("select key from watchlist where kind = 'kalshi_series'")).toEqual([{ key: "KXFEDDECISION" }]);
      expect(await sql.query("select count(*)::int as n from kalshi_candles")).toEqual([{ n: 0 }]);
      await expect(insertMarket(sql)).rejects.toThrow(/permission denied/);
      await expect(sql.query("update watchlist set active = false")).rejects.toThrow(/permission denied/);
      await expect(sql.query("delete from watchlist")).rejects.toThrow(/permission denied/);
      await expect(sql.exec("create table mine (id int)")).rejects.toThrow(/permission denied/);
    });
  });

  it("lets the collector write data, runs, and coverage, but not the watchlist or the schema", async () => {
    await db.asRole(COLLECTOR_ROLE, async (sql) => {
      const [market] = await insertMarket(sql);
      const [run] = await sql.query<{ id: number }>(
        "insert into collection_runs (collector, mode, trigger) values ('kalshi', 'backfill', 'local') returning id",
      );
      await sql.query(
        `insert into kalshi_candles (market_id, period_min, end_ts, yes_bid_close, source, fetched_at, run_id)
         values ($1, 60, '2026-10-01T15:00:00Z', 450000, 'live', now(), $2)`,
        [(market as { id: number }).id, run.id],
      );
      await sql.query("update kalshi_candles set yes_bid_close = 460000");
      await expect(sql.query("delete from kalshi_candles")).rejects.toThrow(/permission denied/);
      await expect(sql.query("update watchlist set active = false")).rejects.toThrow(/permission denied/);
      await expect(
        sql.query("insert into watchlist (kind, key, intervals) values ('stock', 'IBM', array['1day'])"),
      ).rejects.toThrow(/permission denied/);
      await expect(sql.exec("drop table kalshi_candles")).rejects.toThrow(/must be owner/);
      await expect(sql.exec("create table mine (id int)")).rejects.toThrow(/permission denied/);
    });
  });
});
