import { describe, expect, it, vi } from "vitest";
import { httpSql, poolSql, type PgPoolLike } from "./sql";

// The Neon adapters can't reach Neon in tests, so these check what they ask of the driver. The
// queries themselves run on PGlite in the other store tests.

function fakePool(failOn?: string) {
  const statements: string[] = [];
  const client = {
    query: vi.fn(async (text: string) => {
      statements.push(text);
      if (text === failOn) throw new Error("boom");
      return { rows: [{ text }] };
    }),
    release: vi.fn(),
  };
  const pool: PgPoolLike & { end: ReturnType<typeof vi.fn> } = {
    query: vi.fn(),
    connect: vi.fn(async () => client),
    end: vi.fn(async () => {}),
  };
  return { pool, client, statements };
}

describe("poolSql", () => {
  it("runs every statement on one connection and commits a transaction that succeeds", async () => {
    const { pool, statements } = fakePool();
    const sql = await poolSql(pool);
    const value = await sql.transaction(async (tx) => {
      await tx.query("insert 1", [1]);
      return (await tx.query<{ text: string }>("select 2"))[0].text;
    });
    expect(value).toBe("select 2");
    expect(statements).toEqual(["begin", "insert 1", "select 2", "commit"]);
    expect(pool.connect).toHaveBeenCalledTimes(1);
  });

  it("rolls back a transaction that throws, and rethrows", async () => {
    const { pool, statements } = fakePool("insert 1");
    const sql = await poolSql(pool);
    await expect(sql.transaction((tx) => tx.query("insert 1"))).rejects.toThrow("boom");
    expect(statements).toEqual(["begin", "insert 1", "rollback"]);
  });

  it("releases the connection and closes the pool once", async () => {
    const { pool, client } = fakePool();
    const sql = await poolSql(pool);
    await sql.end();
    await sql.end();
    expect(client.release).toHaveBeenCalledTimes(1);
    expect(pool.end).toHaveBeenCalledTimes(1);
  });
});

describe("httpSql", () => {
  it("passes parameters and gives each query its own timeout", async () => {
    const query = vi.fn(async () => [{ n: 1 }]);
    const sql = httpSql({ query }, { timeoutMs: 2500 });
    expect(await sql.query("select $1::int as n", [1])).toEqual([{ n: 1 }]);
    await sql.query("select 1");
    const [first, second] = query.mock.calls as unknown as [string, unknown[], { fetchOptions: { signal: AbortSignal } }][];
    expect(first[0]).toBe("select $1::int as n");
    expect(first[1]).toEqual([1]);
    expect(first[2].fetchOptions.signal).toBeInstanceOf(AbortSignal);
    expect(second[2].fetchOptions.signal).not.toBe(first[2].fetchOptions.signal);
  });
});
