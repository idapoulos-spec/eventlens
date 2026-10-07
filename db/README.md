# EventLens data store

A small Postgres database (Neon, free plan) that scheduled collectors fill with Kalshi candles and stock bars from an editable watchlist. Once the read path lands, the app reads it first and falls back to the live APIs. Without the database variables the app fetches everything live, as before, so nothing here is needed to run EventLens.

Status: the foundation (schema, roles, migrations, watchlist, shared Kalshi code) is built and tested against PGlite. The collectors and the app's read path come next, as separate branches (see `AGENTS.md`). **Stock collection is on hold** until Twelve Data confirms its terms allow storing data: the 7 stock rows in the watchlist start inactive.

## Set up Neon

You need this only to run against a real database. Tests use an in-memory Postgres (PGlite) and need nothing. Keep every value below in `.env.local` (gitignored). Don't paste one into a chat, an issue, or a commit.

1. **Create the project.** Sign up at [neon.com](https://neon.com) on the Free plan and create a project named `eventlens`. Pick the region **AWS US East 1 (N. Virginia)**, next to Vercel's default `iad1` functions, and the default Postgres version (14 or later is required).
2. **Copy the owner connection string.** On the project dashboard, open **Connect**. Choose branch `main`, database `neondb`, and role `neondb_owner`, and turn **Connection pooling off** (migrations need a direct connection). Copy the string into `.env.local`:
   ```
   DATABASE_OWNER_URL=postgresql://neondb_owner:…@ep-….us-east-1.aws.neon.tech/neondb?sslmode=require&channel_binding=require
   ```
3. **Generate the two role passwords straight into `.env.local`**, so they're never shown:
   ```bash
   echo "DATABASE_APP_PASSWORD=$(openssl rand -base64 48 | tr -dc 'A-Za-z0-9' | head -c 40)" >> .env.local
   echo "DATABASE_COLLECTOR_PASSWORD=$(openssl rand -base64 48 | tr -dc 'A-Za-z0-9' | head -c 40)" >> .env.local
   ```
   Passwords must be 32 to 256 letters, digits, `-` or `_`, and the two must differ. Neon requires at least 60 bits of entropy; 40 random letters and digits carry about 238.
4. **Create the roles and tables:**
   ```bash
   pnpm db:migrate
   ```
   It prints role and migration names only, for example `role eventlens_app: created` and `applied 0001_init.sql`. It's safe to rerun: it applies only new migrations and sets both passwords again, so changing a password in `.env.local` and rerunning rotates it.
5. **Build the two role connection strings when they're needed** (the collectors and the read path; not yet). Take the owner string and replace `neondb_owner:<owner password>` with the role and its password:
   - `DATABASE_URL`: `eventlens_app:<DATABASE_APP_PASSWORD>`, on the **pooled** host (add `-pooler` after the endpoint ID, `ep-…-pooler.us-east-1…`, or turn pooling on in **Connect**). Goes in `.env.local`, and in Vercel's Production environment variables, marked Sensitive.
   - `COLLECTOR_DATABASE_URL`: `eventlens_collector:<DATABASE_COLLECTOR_PASSWORD>`. Goes in `.env.local` for local runs, and as a secret of a GitHub **Environment** named `collector`, limited to the `main` branch.
6. **Leave Neon's Data API off** (it's off by default). The database is reachable only with a role's password, over TLS.

For trying a branch's collectors or reads against real data, create a Neon branch (**Branches → New branch** from `main`) and use its connection strings in that worktree's `.env.local`.

## Roles

| Role | Can | Used by |
| --- | --- | --- |
| `neondb_owner` | everything | `pnpm db:migrate`, `pnpm db:watchlist`, from your machine only |
| `eventlens_collector` | read every table; insert and update collected data, runs, and coverage; never delete, never edit the watchlist or schema | the collectors (GitHub Actions, or local runs) |
| `eventlens_app` | read every table | the app on Vercel |

Both roles start each session in UTC, with a statement timeout (app: 5 s; collector: 60 s, and idle transactions end after 60 s).

## Watchlist

```bash
pnpm db:watchlist list --all
pnpm db:watchlist add kalshi_market KXFEDDECISION-26DEC-H0 --intervals 60
pnpm db:watchlist add stock IBM --inactive --note "Waiting on Twelve Data"
pnpm db:watchlist activate stock SPY
pnpm db:watchlist deactivate kalshi_series KXFEDDECISION
pnpm db:watchlist remove stock IBM
```

Kinds are `kalshi_series` (every market in the series, open and settled), `kalshi_event`, `kalshi_market`, and `stock`. Kalshi intervals are candle periods in minutes (`60`, `1440`), stock intervals `30min` and `1day`; both default to all. Deactivating or removing an item keeps what was already collected.

## What's stored

`db/migrations/0001_init.sql` has the details. The rules every writer follows:

- **UTC.** Every time is `timestamptz`. Read `date` columns as text (`trade_date::text`): node-postgres turns a `date` into local midnight.
- **Exact units.** Kalshi prices are integer micro-dollars (`450000` = $0.45) and contract counts integer hundredths (`lib/store/units.ts`). Stock prices are `double precision`.
- **No duplicates.** Candles are keyed by market, period, and end time; bars by instrument, interval, and start. Rewriting a bar changes it only if a value changed, and then sets `updated_at`.
- **Final bars only.** A bar is stored once it has closed (stock bars 5 minutes after, like the benchmark's).
- **Fetch times.** Every row has `fetched_at` and the `run_id` of the run that wrote it. `collection_runs` records each run's requests, Twelve Data credits, and row counts.
- **Gaps come from coverage.** Kalshi writes a candle only when something changes, so a missing candle isn't a gap. Each fetch records the range it covered in `fetch_coverage`; `findGaps` (`lib/store/runs.ts`) returns what no fetch covered.
- **Kalshi's archive.** Markets settled before Kalshi's cutoff (`GET /historical/cutoff`) are only on `/historical`, whose candles name their fields differently. `lib/kalshi/historical.ts` reads them and `lib/kalshi/candles.ts` normalizes both shapes.

## Adding a migration

Add `db/migrations/0002_what_it_does.sql` (four digits, then lowercase words). Grant the roles what they need on new tables in the same file, since the grants in `0001` cover only the tables that existed then. Applied migrations never change: fix forward with a new file. Run `pnpm test` (it applies every migration to a fresh PGlite), then `pnpm db:migrate`.
