import { afterEach, describe, expect, it, vi } from "vitest";
import { getAppSql } from "@/lib/store/db";
import type { Sql } from "@/lib/store/sql";
import { readStore, storeOn } from "./store";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/store/db", () => ({ getAppSql: vi.fn(() => null) }));
const appSql = vi.mocked(getAppSql);

afterEach(() => {
  appSql.mockReset();
  appSql.mockReturnValue(null);
  vi.restoreAllMocks();
});

const failing = (err: unknown): Sql => ({
  query: async () => {
    throw err;
  },
});

describe("readStore", () => {
  it("is off, and reads nothing, without DATABASE_URL", async () => {
    const read = vi.fn();
    expect(storeOn()).toBe(false);
    expect(await readStore("anything", read)).toBeNull();
    expect(read).not.toHaveBeenCalled();
  });

  it("returns what the read returns", async () => {
    appSql.mockReturnValue({ query: async <T,>() => [{ n: 1 }] as T[] });
    expect(storeOn()).toBe(true);
    expect(await readStore("rows", (sql) => sql.query("select 1 as n"))).toEqual([{ n: 1 }]);
  });

  it("falls back on a failure, logging only fixed words and the Postgres error code", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    // Built in pieces so no connection-string scanner mistakes it for a real one.
    const secret = ["postgresql", "://eventlens_app:", "not-a-password", "@db.example.test/neondb"].join("");

    const denied = Object.assign(new Error(`permission denied (${secret})`), { code: "42501" });
    appSql.mockReturnValue(failing(denied));
    expect(await readStore("Kalshi history", (sql) => sql.query("select 1"))).toBeNull();

    const timeout = Object.assign(new Error(`Error connecting to database: ${secret}`), {
      sourceError: new DOMException("The operation was aborted due to timeout", "TimeoutError"),
    });
    appSql.mockReturnValue(failing(timeout));
    expect(await readStore("Kalshi history", (sql) => sql.query("select 1"))).toBeNull();

    appSql.mockReturnValue(failing(new Error(secret)));
    expect(await readStore("Kalshi history", (sql) => sql.query("select 1"))).toBeNull();

    expect(warn.mock.calls).toEqual([
      ["[store] Kalshi history unavailable (SQLSTATE 42501); using live data"],
      ["[store] Kalshi history unavailable (timeout); using live data"],
      ["[store] Kalshi history unavailable (error); using live data"],
    ]);
  });
});
