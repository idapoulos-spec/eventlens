<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

## Working in parallel

The data store (see `db/README.md`) is built on parallel branches, one per area below, each in its own git worktree, after the foundation branch (`feat/store-foundation`) merges. Stay inside your area. If you need a change anywhere else, don't make it: stop and describe the change you need.

### File ownership

| Area | Dev port | Owns |
| --- | --- | --- |
| A. Kalshi collection | 3001 | new `lib/collect/kalshi/`, `scripts/collect-kalshi.ts`, `.github/workflows/collect-kalshi.yml` |
| B. Stock collection (**on hold** until Twelve Data confirms storing its data is allowed) | 3002 | new `lib/collect/stocks/`, `lib/market-data/history.ts`, `scripts/collect-stocks.ts`, `.github/workflows/collect-stocks.yml` |
| C. App read path | 3003 | new `lib/history/`; edits to `lib/kalshi/client.ts`, `lib/market-data/twelve-data.ts`, `lib/market-data/benchmark.ts`, `components/Dashboard.tsx`, and the Research panel's data loading |

- **Tests** go next to the code they test and belong to that code's area. Test against mocked `fetch` and the in-memory store (`createTestDb()` in `lib/store/test-db.ts`), not the live APIs or Neon.
- **Contracts are frozen:** `db/migrations/0001_init.sql` (tables, units, and grants), `lib/store/` (connections, the `Sql` interface, migrations, runs and coverage, the watchlist, units), `lib/kalshi/historical.ts`, and `lib/kalshi/candles.ts`. All three areas build against them at the same time. A schema change is a new migration, agreed before anyone writes it.
- **Import from file paths** (`@/lib/kalshi/historical`, `@/lib/store/runs`), not the `index.ts` barrels, so no branch edits a barrel.
- **`lib/market-data/` and `lib/kalshi/`** also serve the dashboard. A and B add files there; only C changes what existing exports do.
- **Everything else is shared.** Import it, don't edit it. That includes `components/TickerForm.tsx`, `app/page.tsx`, `proxy.ts`, `lib/auth/`, `lib/analytics/`, the other `lib/*.ts` helpers, config files, `.github/workflows/ci.yml`, and this file.
- **Don't edit `README.md`, `package.json`, or `pnpm-lock.yaml`** on a parallel branch: nearly every branch would touch them, so they would conflict on every merge. The README is updated once after the branches merge. If you need a dependency, don't install it; say which one and why.
- **Each area gets its own Neon branch** for trying collectors or reads against a real database (Neon → Branches → New branch from `main`). Never point a parallel branch at the production database.
- **Secrets stay in `.env.local`.** Never print a connection string, password, or API key, and never ask for one in chat. Collector logs in GitHub Actions are public (the repo is public): log counts and tickers only, never prices, rows, or URLs.

### Twelve Data limits

- The free plan allows **8 requests a minute and 800 a day**. Every worktree uses the same key from `.env.local`, so those limits cover all parallel branches together, not each one.
- One analysis costs 3 requests (1 if the same stock was analyzed in the last 60 seconds), plus 2 for Research's SPY benchmark when the server doesn't have it in memory (it's kept until its next 30-minute bar settles). Picking another benchmark costs 2 more. Four branches each running one analysis a minute already exceeds the limit. When the quota runs out, the stock panel shows "Twelve Data rate limit reached": that's the shared quota, not your code.
- Test against mocked `fetch` (see `lib/market-data/twelve-data.test.ts` and `lib/kalshi/client.test.ts`), not the live APIs, and never call them in a loop or script while developing. The scheduled collectors are the exception: they pace their requests and cap the credits each run spends.
- Count every Twelve Data request, search included, as at least 1 credit. Stock search must not call Twelve Data on every keystroke.
- The app's rate limiters keep counts in each server's memory, so each dev server has its own budget. They don't protect the shared key.

### Dev servers

Each area runs its dev server on its own port from the table (3001–3003); 3000 stays free for `main`:

```bash
pnpm dev -p 3001
```

Next.js runs only one `next dev` per directory (a second one exits with "Another next dev server is already running"), so each dev server needs its own worktree. A new worktree has no `node_modules` or `.env.local` (both are gitignored): run `pnpm install` and copy `.env.local` from the main checkout.

Before pushing, run `pnpm lint`, `pnpm test`, and `pnpm build`. CI (`.github/workflows/ci.yml`) runs the same three on every push and pull request.
