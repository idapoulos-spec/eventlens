# EventLens

EventLens is a research dashboard that compares [Kalshi](https://kalshi.com) prediction-market data with stock-market data.

Enter a stock ticker (e.g. `NVDA`) and a Kalshi market ticker (e.g. `KXFEDDECISION-26OCT-H25`), click **Analyze**, and EventLens shows:

- **Kalshi market:** title, implied probability, YES bid / ask, last price, 24-hour volume, open interest, 1-hour and 24-hour probability change, and an event-uncertainty score
- **Stock:** current price, daily change, volume, and 30-day realized volatility (via [Twelve Data](https://twelvedata.com))
- **Charts:** Kalshi probability vs. stock return over the last 7 days, aligned on timestamps, plus the probability history and a ~3-month stock price chart

> Experimental market-research tool. Metrics are informational and are not investment recommendations.

## Tech stack

Next.js (App Router), TypeScript, Tailwind CSS, Recharts, pnpm.

## Getting started

### Prerequisites

- Node.js 20.9 or later
- pnpm (`npm install -g pnpm`)

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

The free Twelve Data plan allows 8 requests per minute. Each analysis uses 3 (quote, hourly bars, daily bars), and responses are cached for 60 seconds.

### Run locally

```bash
pnpm dev
```

Open <http://localhost:3000>.

### Other scripts

```bash
pnpm lint    # ESLint
pnpm build   # production build (includes type checking)
pnpm start   # serve the production build
```

## Finding a Kalshi market ticker

Use a **market** ticker, not an event or series ticker. Market tickers appear in Kalshi market URLs and API responses, and look like `KXFEDDECISION-26OCT-H25` or `KXRECSSNBER-27`. The example buttons in the app use real markets, but markets close over time, so an example may stop working.

## How metrics are calculated

All calculations are pure functions in `lib/analytics/`.

| Metric | Definition |
| --- | --- |
| Implied probability | Midpoint of YES bid and YES ask: `(yesBid + yesAsk) / 2`. If one side of the book is empty, the last trade price is used. |
| 1h change | Current probability minus the probability in effect exactly 60 minutes ago, in percentage points. Uses 1-minute candles. Kalshi only records a candle when something changes, so the comparison point is the last one at or before that moment; the dashboard shows its time. |
| 24h change | Same as the 1h change, but against hourly candles, so the comparison point is 24–25 hours old. |
| Uncertainty | Binary entropy `H(p) = −p·log₂p − (1−p)·log₂(1−p)`, scaled to 0–100. 100 at 50%, 0 at 0% or 100%. |
| Realized volatility | Sample standard deviation of the last 30 daily log returns, annualized with √252. |
| Relative volume | Today's volume as a percentage of average volume. |
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

## Deploying to Vercel

1. Import the GitHub repository in Vercel.
2. Add `TWELVE_DATA_API_KEY` under **Project → Settings → Environment Variables**.
3. Deploy. Vercel detects Next.js and pnpm automatically.

## Scope

This is an MVP. It has no trading functionality, user accounts, database, or automatic event-to-stock mapping.
