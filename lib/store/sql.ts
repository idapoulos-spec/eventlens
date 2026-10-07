// The small slice of a Postgres client the store needs, so the same queries run on Neon (in the
// app, in scripts, and in GitHub Actions) and on PGlite (in tests). Driver-specific code stays in
// the adapters below.
//
// Rows come back as each driver parses them. Both parse timestamptz as Date and int4 / float8 as
// number, but not every type the same way, so queries cast where it matters:
// - int8 (bigint): node-postgres (Neon) returns a string and PGlite a bigint. Cast with ::float8
//   (exact below 2^53) or ::int.
// - date: node-postgres builds a Date at local midnight. Select it as ::text ("YYYY-MM-DD").
// - numeric: a string in both. The schema doesn't use it.

/** One result row, keyed by column name. */
export type Row = Record<string, unknown>;

/** Run one statement with $1, $2, … parameters. */
export interface Sql {
  query<T extends object = Row>(text: string, params?: unknown[]): Promise<T[]>;
}

/** A connection that can also run several statements at once and transactions. Scripts and tests only. */
export interface SessionSql extends Sql {
  /** Several statements separated by semicolons, without parameters (a migration file). */
  exec(text: string): Promise<void>;
  /** Commits if `fn` resolves, rolls back if it throws. Don't nest. */
  transaction<T>(fn: (tx: SessionSql) => Promise<T>): Promise<T>;
  /** Closes the connection. */
  end(): Promise<void>;
}

// ---- Neon over HTTP: one round trip per query, nothing to pool. For the app's reads. ----

/** What httpSql uses of `neon(url)` from @neondatabase/serverless. */
export interface NeonHttpLike {
  query(text: string, params?: unknown[], opts?: { fetchOptions?: Record<string, unknown> }): Promise<unknown>;
}

/** Each query gives up after `timeoutMs`. */
export function httpSql(neonQuery: NeonHttpLike, { timeoutMs }: { timeoutMs: number }): Sql {
  return {
    async query<T extends object>(text: string, params: unknown[] = []) {
      const rows = await neonQuery.query(text, params, { fetchOptions: { signal: AbortSignal.timeout(timeoutMs) } });
      return rows as T[];
    },
  };
}

// ---- Neon over WebSocket (node-postgres compatible Pool): for migrations and collectors. ----

interface PgClientLike {
  query(text: string, params?: unknown[]): Promise<{ rows: unknown[] } | { rows: unknown[] }[]>;
  release(): void;
}

/** What poolSql uses of a `Pool` from @neondatabase/serverless. */
export interface PgPoolLike {
  query(text: string, params?: unknown[]): Promise<{ rows: unknown[] }>;
  connect(): Promise<PgClientLike>;
  end(): Promise<void>;
}

function clientSql(client: PgClientLike, end: () => Promise<void>): SessionSql {
  const session: SessionSql = {
    async query<T extends object>(text: string, params: unknown[] = []) {
      const result = await client.query(text, params);
      return (Array.isArray(result) ? (result.at(-1)?.rows ?? []) : result.rows) as T[];
    },
    async exec(text) {
      // Without parameters, node-postgres sends the simple query protocol, which accepts several statements.
      await client.query(text);
    },
    async transaction(fn) {
      await client.query("begin");
      try {
        const value = await fn(session);
        await client.query("commit");
        return value;
      } catch (err) {
        await client.query("rollback").catch(() => {});
        throw err;
      }
    },
    end,
  };
  return session;
}

/**
 * A session on one pooled connection, held until `end()`, so transactions and session settings
 * stay on the same connection.
 */
export async function poolSql(pool: PgPoolLike): Promise<SessionSql> {
  const client = await pool.connect();
  let ended = false;
  return clientSql(client, async () => {
    if (ended) return;
    ended = true;
    client.release();
    await pool.end();
  });
}

// ---- PGlite: real Postgres in this process, for tests. ----

/** What pgliteSql uses of a PGlite instance (or of the transaction it passes to `transaction`). */
export interface PGliteLike {
  query(text: string, params?: unknown[]): Promise<{ rows: unknown[] }>;
  exec(text: string): Promise<unknown>;
  transaction?<T>(fn: (tx: PGliteLike) => Promise<T>): Promise<T>;
  close?(): Promise<void>;
}

export function pgliteSql(db: PGliteLike): SessionSql {
  return {
    async query<T extends object>(text: string, params: unknown[] = []) {
      return (await db.query(text, params)).rows as T[];
    },
    async exec(text) {
      await db.exec(text);
    },
    async transaction(fn) {
      if (!db.transaction) throw new Error("Transactions don't nest.");
      return db.transaction((tx) => fn(pgliteSql(tx)));
    },
    async end() {
      await db.close?.();
    },
  };
}
