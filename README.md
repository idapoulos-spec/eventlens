# EventLens

EventLens is a research dashboard that compares [Kalshi](https://kalshi.com) prediction-market data with stock-market data.

Enter a stock ticker (e.g. `NVDA`) and a Kalshi market ticker (e.g. `KXFEDDECISION-26OCT-H25`), click **Analyze**, and EventLens shows:

- **Kalshi market:** title, implied probability, YES bid / ask, last price, 24-hour volume, open interest, 1-hour and 24-hour probability change, and an event-uncertainty score
- **Stock:** current price, daily change, volume (compared with average volume once the market has closed), and 30-day realized volatility (via [Twelve Data](https://twelvedata.com))
- **Charts:** Kalshi probability vs. stock return over the last 7 days, aligned on timestamps, plus the probability history and ~3 months of daily closes

> Experimental market-research tool. Metrics are informational and are not investment recommendations.

## Tech stack

Next.js (App Router), TypeScript, Tailwind CSS, Recharts, pnpm.

## Getting started

### Prerequisites

- Node.js 24 (pinned in `package.json` under `engines`)
- pnpm 10 (`npm install -g pnpm@10`). The exact version is pinned in `package.json` under `packageManager`.

### Install

```bash
pnpm install
```

### Configure the Twelve Data API key

Stock data comes from Twelve Data. Kalshi data uses public endpoints and needs no key.

1. Get a free API key at <https://twelvedata.com/pricing>.
2. Copy the example env file and add your key:

   ```bash
   cp .env.example .env.local
   ```

   ```env
   TWELVE_DATA_API_KEY=your_key_here
   ```

The key is only read on the server and is never sent to the browser. Without it, the app still runs: Kalshi data loads and the stock section explains how to add the key.

The free Twelve Data plan allows 8 requests per minute. Each analysis uses 3 (quote, hourly bars, daily bars). Current quotes from Twelve Data and Kalshi are fetched fresh on every request; price history is cached for 60 seconds, so re-analyzing the same ticker within a minute uses only 1.

### Run locally

```bash
pnpm dev
```

Open <http://localhost:3000>.

The dev server only listens on `127.0.0.1`, so other devices on your network cannot reach it (or spend your API credits). To test from a phone on the same network, run `pnpm exec next dev -H 0.0.0.0` instead.

### Other scripts

```bash
pnpm lint    # ESLint
pnpm test    # unit tests (Vitest)
pnpm build   # production build (includes type checking)
pnpm start   # serve the production build
```

## Finding a Kalshi market ticker

Use a **market** ticker, not an event or series ticker. Market tickers appear in Kalshi market URLs and API responses, and look like `KXFEDDECISION-26OCT-H25` or `KXRECSSNBER-27`. The example buttons in the app use real markets, but markets close over time, so an example may stop working.

## How metrics are calculated

All calculations are pure functions in `lib/analytics/`.

| Metric | Definition |
| --- | --- |
| Implied probability | Midpoint of YES bid and YES ask: `(yesBid + yesAsk) / 2`. If one side of the book is empty, the last trade price is used, and the dashboard says when that trade happened. History points are estimated the same way from each candle, using the previous trade if none happened in that period. Only shown while a market is open for trading: closed and settled markets show their result instead, and no probability, change, or uncertainty is derived from their last trade. |
| 1h change | Current probability minus the probability in effect exactly 60 minutes ago, in percentage points. Uses 1-minute candles. Kalshi only records a candle when something changes, so the comparison point is the last one at or before that moment; the dashboard shows its time, and notes when it was estimated differently from the current probability (midpoint vs. last trade). |
| 24h change | Same as the 1h change, against the probability in effect exactly 24 hours ago, from the hour of 1-minute candles before that moment. |
| Uncertainty | Binary entropy `H(p) = −p·log₂p − (1−p)·log₂(1−p)`, scaled to 0–100. 100 at 50%, 0 at 0% or 100%. |
| Realized volatility | Sample standard deviation of the last 30 daily log returns, annualized with √252. Uses completed sessions only: while the market is open, today's unfinished bar is left out (the daily close chart leaves it out too). |
| Relative volume | The latest session's volume as a percentage of average volume. Not shown while the market is open: today's volume is still accumulating, and on Twelve Data's free plan it can miss part of the market, so it isn't comparable with the average until the close. |
| Alignment | The two hourly series are merged on the union of their timestamps, each carrying forward its last value (an as-of join). Stock bars are stamped at their close time; for US stocks the shortened last bar of the day is stamped at the 4:00 PM New York close. |

## Project structure

```
app/                  Next.js routes (page.tsx renders the dashboard server-side)
components/           UI components (cards, form, panels)
  charts/             Recharts client components
lib/
  kalshi/             Kalshi API client + normalized types (server-only)
  market-data/        Twelve Data client + normalized types (server-only)
  analytics/          Pure metric and alignment functions
  validation.ts       Ticker input validation
  format.ts           Number and date formatting
```

Third-party API calls live in `lib/kalshi` and `lib/market-data`, run only on the server (enforced with `server-only`), and return normalized TypeScript types. The UI never calls third-party APIs directly.

## Security

- `TWELVE_DATA_API_KEY` is read only in server-only code and sent to Twelve Data in an `Authorization` header, never in a URL, so it stays out of browser code, cached request URLs, and logs.
- Ticker inputs are validated on the server before any upstream request.
- Users see fixed error messages. Twelve Data's own error text is logged on the server only, with the key redacted.
- Each client IP can run 5 analyses a minute and 30 an hour (`lib/analysis-rate-limit.ts`).
- Every upstream request times out after 6 seconds, and the Kalshi and stock sections load independently, so one slow API never hides the other's data.

**How much the rate limit protects you.** The limiter keeps its counts in the server's memory. That is enough to stop one person repeatedly hammering the site, but it is not a hard guarantee:

- On Vercel, each server instance keeps its own counts, and counts reset when an instance restarts. A quiet site usually runs on one warm instance, so the limit mostly holds; under heavier traffic Vercel starts more instances and each one allows its own 5 per minute.
- Limits are per IP. People behind the same IP (an office, a mobile carrier) share one limit, and someone using many IPs can get around it.
- It does not cap total usage across all visitors, so it cannot stop the site as a whole from using up the Twelve Data plan.

For a hard limit, use a shared store such as Upstash Redis (`@upstash/ratelimit`) or a rate-limiting rule in the Vercel Firewall.

## Deploying to Vercel

1. Import the GitHub repository in Vercel.
2. Add `TWELVE_DATA_API_KEY` under **Project → Settings → Environment Variables** (Production, plus Preview if you want preview deployments to show stock data). The key is only read at request time, so the build does not need it. If it is missing, the site still works and shows that stock data isn't set up; the server log explains how to fix it.
3. Deploy. Vercel detects Next.js, installs with pnpm 10 from `pnpm-lock.yaml`, and uses Node.js 24 from `engines`.

The page's server function is capped at 30 seconds (`maxDuration` in `app/page.tsx`). All timestamps are shown in New York time with the zone labeled, regardless of the server's time zone.

## Scope

This is an MVP. It has no trading functionality, user accounts, database, or automatic event-to-stock mapping.
