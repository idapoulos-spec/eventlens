# EventLens data store

A small Postgres database (Neon, free plan) that scheduled collectors fill with Kalshi candles and stock bars from an editable watchlist. The app reads it first and falls back to the live APIs. Without the database variables the app fetches everything live, as before, so nothing here is needed to run EventLens.

Status: the Kalshi collector runs every 6 hours in GitHub Actions (see [Collecting Kalshi data](#collecting-kalshi-data)), and with `DATABASE_URL` set the app reads Research's Kalshi history from the store (see [How the app reads it](#how-the-app-reads-it)). **Stock collection is on hold** until Twelve Data confirms its terms allow storing data: the 7 stock rows in the watchlist start inactive, and there's no stock collector yet.

## Set up Neon

You need this only to run against a real database. Tests use an in-memory Postgres (PGlite) and need nothing. Keep every value below in `.env.local` (gitignored). Don't paste one into a chat, an issue, or a commit.

1. **Create the project.** Sign up at [neon.com](https://neon.com) on the Free plan and create a project named `eventlens`. Pick the region **AWS US East 1 (N. Virginia)**, next to Vercel's default `iad1` functions, and the default Postgres version (14 or later is required).
2. **Copy the owner connection string.** On the project dashboard, open **Connect**. Choose branch `production` (Neon's default branch), database `neondb`, and role `neondb_owner`, and turn **Connection pooling off** (migrations need a direct connection). Copy the string into `.env.local`:
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
5. **Build the two role connection strings.** Take the owner string and replace `neondb_owner:<owner password>` with the role and its password:
   - `DATABASE_URL`: `eventlens_app:<DATABASE_APP_PASSWORD>`, on the **pooled** host (add `-pooler` after the endpoint ID, `ep-…-pooler.us-east-1…`, or turn pooling on in **Connect**). Goes in `.env.local`, and in Vercel's Production environment variables, marked Sensitive.
   - `COLLECTOR_DATABASE_URL`: `eventlens_collector:<DATABASE_COLLECTOR_PASSWORD>`. Goes in `.env.local` for local runs, and as a secret of a GitHub **Environment** named `collector`, limited to the `main` branch.
6. **Leave Neon's Data API off** (it's off by default). The database is reachable only with a role's password, over TLS.
7. **Fill it.** Run **Actions → Collect Kalshi → Run workflow** with mode `backfill` once (see [Collecting Kalshi data](#collecting-kalshi-data)). After that the schedule keeps it current.

To try collector or read changes against real data without touching `production`, create a Neon branch (**Branches → New branch** from `production`) and use its connection strings in that worktree's `.env.local`.

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

## Collecting Kalshi data

`scripts/collect-kalshi.ts` stores the hourly and daily candles (periods `60` and `1440`) of every market the active watchlist items name, as `eventlens_collector`. Locally it reads `COLLECTOR_DATABASE_URL` from `.env.local`; point that at a Neon branch, not `production`, while trying changes.

```bash
pnpm collect:kalshi                   # incremental, the default
pnpm collect:kalshi --mode backfill
pnpm collect:kalshi --mode repair
```

| Mode | Fetches | When |
| --- | --- | --- |
| `incremental` | Each market from two periods before the end of its coverage to now (a market never fetched, from its open), skipping markets covered through their end; then up to 25 gap windows. | Every 6 hours, on the schedule. |
| `backfill` | Every market's whole history again. A stored candle changes only where Kalshi's values did. | Once after setup, or to fetch everything again. |
| `repair` | Every gap, and nothing else. | When a run ends `partial`. |

- **Where candles come from.** Markets are listed from both Kalshi's live endpoints and its archive, and the list a market comes from says which serves its candles. A market that moves to the archive during a run is fetched from the archive, never recorded as covered and empty.
- **Coverage.** For each period, a market is covered from its open (to the minute) to one period after the later of its close and settlement, or to 5 minutes ago while it's open. Requests span at most 4,800 periods (200 days of hourly candles; the archive allows 5,000), and each window's candles and coverage commit together, so a window that fails leaves a gap for the next run.
- **Runs.** Each run is a row in `collection_runs`: `ok` if no window failed and no gap is left, `partial` otherwise, or `failed` if it stopped early. Requests are paced at 4 a second and retried on rate limits, timeouts, and connection failures. A run still `running` two hours after it started (the workflow stops at 30 minutes) is marked `failed` by the next one.
- **Size.** On 2026-10-08, the 200 KXFEDDECISION markets came to about 438,000 hourly and 28,000 daily candles, in an 83 MB database (the free plan allows 1 GB).

### On GitHub Actions

`.github/workflows/collect-kalshi.yml` runs an incremental collection every 6 hours at :23, and any mode on demand from **Actions → Collect Kalshi → Run workflow**. It reads `COLLECTOR_DATABASE_URL` from the `collector` environment, which only `main` can use (step 5 above). Runs never overlap and stop after 30 minutes.

- **Logs are public** (the repository is public): the collector prints counts, tickers, and store sizes only, never prices, rows, URLs, or error messages.
- **Failures email you.** The script exits 1 unless the run is `ok`, so GitHub sends its failed-workflow email.
- **Late or skipped runs** are normal at busy times; the next run catches up. GitHub turns schedules off after 60 days without activity in a public repository: turn the workflow back on from the Actions tab.

## How the app reads it

With `DATABASE_URL` set, the app reads the store as `eventlens_app` over Neon's HTTP driver. Each query gives up after 2.5 seconds, and a read that fails logs one fixed line (a Postgres error code at most) and the page fetches live instead. Without `DATABASE_URL` every upstream request is the same as before; `lib/history/analysis.test.ts` pins them.

- **Kalshi history.** Research's 97 days of hourly candles (90, plus a week to find the probability in effect at the start) come from the store when its coverage spans them. When only the end is missing, a live request fetches the rest, overlapping the stored candles by 2 hours (live wins); if that fails, Research shows the stored part. Otherwise it fetches live as before. The Sources note says how far stored history reaches.
- **Settled markets.** A market settled before Kalshi's archive cutoff answers 404 on the live API, so the app uses its stored row (only once it's settled) or Kalshi's archive, and its candles come from the store or the archive.
- **Windows end at the close.** For a closed market, Research's 7, 30, and 90-day windows count back from its close instead of now, and the stock's bars and the benchmark cover that window (`/api/benchmark?symbol=…&end=…`). An analysis still uses at most 5 Twelve Data credits.
- **Stock bars** are read from the store when its coverage spans the window. None are stored yet, since stock collection is on hold.

## What's stored

`db/migrations/0001_init.sql` has the details. The rules every writer follows:

- **UTC.** Every time is `timestamptz`. Read `date` columns as text (`trade_date::text`): node-postgres turns a `date` into local midnight.
- **Exact units.** Kalshi prices are integer micro-dollars (`450000` = $0.45) and contract counts integer hundredths (`lib/store/units.ts`). Stock prices are `double precision`.
- **No duplicates.** Candles are keyed by market, period, and end time; bars by instrument, interval, and start. Rewriting a bar changes it only if a value changed, and then sets `updated_at`.
- **Final bars only.** A bar is stored once it has closed (stock bars 5 minutes after, like the benchmark's).
- **Fetch times.** Every row has `fetched_at` and the `run_id` of the run that wrote it. `collection_runs` records each run's requests, Twelve Data credits, and row counts.
- **Gaps come from coverage.** Kalshi writes a candle only when something changes, so a missing candle isn't a gap. Each fetch records the range it covered in `fetch_coverage`; `findGaps` (`lib/store/runs.ts`) returns what no fetch covered.
- **Kalshi's archive.** Markets settled before Kalshi's cutoff (`GET /historical/cutoff`) are only on `/historical`, whose candles name their fields differently and come at most 5,000 to a request (the live endpoint allows 10,000). `lib/kalshi/historical.ts` reads them and `lib/kalshi/candles.ts` normalizes both shapes.

## Adding a migration

Add `db/migrations/0002_what_it_does.sql` (four digits, then lowercase words). Grant the roles what they need on new tables in the same file, since the grants in `0001` cover only the tables that existed then. Applied migrations never change: fix forward with a new file. Run `pnpm test` (it applies every migration to a fresh PGlite), then `pnpm db:migrate`.
