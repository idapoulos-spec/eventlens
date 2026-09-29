<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

## Working in parallel

Search is built on parallel branches, one per area below, each in its own git worktree. Stay inside your area. If you need a change anywhere else, don't make it: stop and describe the change you need.

### File ownership

| Area | Dev port | Owns |
| --- | --- | --- |
| Stock search API | 3001 | `app/api/search/stocks/`, `lib/market-data/` |
| Kalshi search API | 3002 | `app/api/search/kalshi/`, `lib/kalshi/` |
| Stock search UI | 3003 | `components/search/StockSearch.tsx`, new `components/search/Stock*.tsx` |
| Kalshi search UI | 3004 | `components/search/KalshiSearch.tsx`, new `components/search/Kalshi*.tsx` |

- **Tests** go next to the code they test and belong to that code's area.
- **`lib/market-data/` and `lib/kalshi/`** also serve the dashboard. Add files and exports there (exporting an existing helper is fine), but don't change what existing exports do.
- **Contracts are frozen:** `lib/search/types.ts` (result types, response shapes, and the `value`/`onSelect` props of both search components), `lib/search/api.ts` (query validation and the error envelope), and `components/search/field.ts` (shared field styling). Both sides of each contract build against them at the same time.
- **Everything else is shared.** Import it, don't edit it. That includes `components/TickerForm.tsx`, `app/page.tsx`, the dashboard components, `lib/analytics/`, the other `lib/*.ts` helpers, config files, `.github/`, and this file.
- **Don't edit `README.md`, `package.json`, or `pnpm-lock.yaml`** on a parallel branch: nearly every branch would touch them, so they would conflict on every merge. The README is updated once after the branches merge. If you need a dependency, don't install it; say which one and why.
- **UI areas:** the stub routes return empty lists until the API areas merge. Develop against fixture results kept in your own files, not by editing the routes. If both search fields need the same piece (e.g. a combobox), build it in your own files; shared pieces are extracted after merging.

### Twelve Data limits

- The free plan allows **8 requests a minute and 800 a day**. Every worktree uses the same key from `.env.local`, so those limits cover all parallel branches together, not each one.
- One analysis costs 3 requests (1 if the same stock was analyzed in the last 60 seconds). Four branches each running one analysis a minute already exceeds the limit. When the quota runs out, the stock panel shows "Twelve Data rate limit reached": that's the shared quota, not your code.
- Test against mocked `fetch` (see `lib/market-data/twelve-data.test.ts` and `lib/kalshi/client.test.ts`), not the live APIs, and never call them in a loop or script.
- Count every Twelve Data request, search included, as at least 1 credit. Stock search must not call Twelve Data on every keystroke.
- The app's rate limiters keep counts in each server's memory, so each dev server has its own budget. They don't protect the shared key.

### Dev servers

Each area runs its dev server on its own port from the table (3001–3004); 3000 stays free for `main`:

```bash
pnpm dev -p 3001
```

Next.js runs only one `next dev` per directory (a second one exits with "Another next dev server is already running"), so each dev server needs its own worktree. A new worktree has no `node_modules` or `.env.local` (both are gitignored): run `pnpm install` and copy `.env.local` from the main checkout.

Before pushing, run `pnpm lint`, `pnpm test`, and `pnpm build`. CI (`.github/workflows/ci.yml`) runs the same three on every push and pull request.
