# EventLens

EventLens is a research dashboard that compares [Kalshi](https://kalshi.com) prediction-market data with stock-market data.

Pick a stock or ETF (search by ticker or name, e.g. `NVDA` or "nvidia") and a Kalshi market (search by keyword, e.g. "fed october", or paste a market ticker such as `KXFEDDECISION-26OCT-H25`), click **Analyze**, and EventLens shows:

- **Kalshi market:** title, implied probability, YES bid / ask, last price, 24-hour volume, open interest, 1-hour and 24-hour probability change, and an event-uncertainty score
- **Stock:** current price, daily change, volume (compared with average volume once the market has closed), and 30-day realized volatility (via [Twelve Data](https://twelvedata.com))
- **Charts:** Kalshi probability vs. stock return over the last 7 days, aligned on timestamps, plus the probability history and ~3 months of daily closes
- **Research:** how Kalshi probability changes relate to stock returns over 7, 30, or 90 days (hourly or daily): lead-lag correlation, rolling correlation, and an event study around Kalshi jumps, on raw or market-adjusted returns (net of SPY or another benchmark), with sample sizes, caveats, and a CSV export of the aligned data

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

The key is only read on the server and is never sent to the browser. Without it, the app still runs: Kalshi data and Kalshi search work, stock search says it's unavailable (a typed ticker still works), and the stock section explains how to add the key.

The free Twelve Data plan allows 8 requests per minute and 800 per day. Each analysis uses 3 (quote, 30-minute bars, daily bars). Current quotes from Twelve Data and Kalshi are fetched fresh on every request; price history is cached for 60 seconds, so re-analyzing the same ticker within a minute uses only 1. Submitting the analysis that's already on screen again within 60 seconds only scrolls to its results and uses none.

Research's benchmark (SPY by default) adds 2 more (30-minute and daily bars, no quote) when the server doesn't already have it in memory, so an analysis uses 3 or 5. Each server instance keeps a benchmark until its next 30-minute bar has settled (at most about 30 minutes), so SPY costs at most 2 requests per half hour per instance however many analyses run; it isn't requested when the stock is SPY. Picking another benchmark in the Research section costs 2 if the server doesn't have it either, and switching back to one already loaded costs none. Everything else in Research (window, resolution, raw or market-adjusted returns, jump size, the CSV) happens in the browser with data that's already loaded.

Stock search uses 2 requests per server instance per day, however much people type: see [Search](#search).

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

## Search

Both fields take a ticker or search text. Results appear once typing pauses (250 ms); ↑ and ↓ move through them, Enter picks one, and Esc closes the list. Searching never sends the query to Twelve Data or Kalshi: each search route answers from an index it keeps in the server's memory.

### Stock search

Finds US stocks and ETFs by ticker or company name, 10 results at a time. Exact tickers come first, then common stock and ETFs listed on NASDAQ, NYSE, or Cboe before warrants, rights, units, and OTC listings, then ticker prefixes before name matches. In the stock field, Enter on a typed ticker that is also the top result analyzes it right away.

- **Index:** Twelve Data's `/stocks` and `/etfs` lists for the United States (about 20,000 and 11,000 entries), downloaded once a day per server instance: 2 Twelve Data requests. The first search of the day waits for the download, which has taken anywhere from 1 to 25 seconds, so the field says why if it's slow (the download times out after 45 seconds). Concurrent searches share one download. After a failed download, searches report the error for 5 minutes instead of retrying; if a daily refresh fails, the previous day's lists keep serving.
- **Left out:** mutual funds and unit trusts from the ETF list (5- and 6-letter symbols ending in X, which have no intraday prices) and symbols the dashboard can't analyze, such as preferreds (`BAC.PR.S`).
- **Popular symbols and aliases:** the lists carry no popularity data, so `lib/market-data/popular.ts` names about 30 popular symbols, most popular first, some with aliases: "google" finds GOOGL, and "s&p 500" ranks SPY first. Among equally good matches, popular symbols come first.

### Kalshi search

Kalshi's API has no keyword search, so the server builds an index of every open market in every open event by paging through `GET /events` (about 12,000 events and 114,000 markets in September 2026: 61 pages, about 15 seconds). Pages are requested one at a time, at most 4 a second. The index is used as is for 3 minutes; after that, searches keep using it for up to 15 minutes while a single refresh runs in the background. After a failed build, Kalshi isn't asked again for 30 seconds. So Kalshi traffic doesn't grow with the number of searches.

- **Matching:** every word of the query must start a word in the market's title or YES side, its event, its category, or its ticker ("fed hik" finds "Will the Fed hike…"). A pasted ticker ranks first; among equal matches, the most traded markets come first. Up to 20 results, each with its chance (at most a few minutes old) and close date. Markets that share a title within an event show their YES side underneath (e.g. each candidate in "Who will the next Pope be?").
- **Open markets only.** To analyze a closed or settled market, paste its ticker.

Use a **market** ticker, not an event or series ticker. Market tickers appear in Kalshi market URLs and API responses, and look like `KXFEDDECISION-26OCT-H25` or `KXRECSSNBER-27`. The example buttons in the app use real markets, but markets close over time, so an example may stop working.

### Typed text that isn't a ticker

Some names and keywords also look like tickers ("nvidia", "recession"). Analyzing one would only fail, and would spend Twelve Data requests on the stock side. So when a field's search has already shown that its text isn't a listed ticker, **Analyze** asks to pick from the list instead (e.g. "Pick one from the list, such as NVDA (NVIDIA Corporation)"). Tickers the search hasn't seen go straight through.

## Recent analyses and sharing

- **Links:** every analysis has its own URL (`/?stock=NVDA&kalshi=KXFEDDECISION-26OCT-H25`). **Copy link** above the results copies it, and a shared link's tab title names the analysis. Back and Forward move between analyses, and the fields follow.
- **Recent analyses:** the last 6 analyses viewed in this browser, newest first and named after the Kalshi market, are listed under the form, except the one on screen. Each has a remove button. They're kept in `localStorage` and never sent to the server. Analyses with a ticker that doesn't exist, or a stock the Twelve Data plan doesn't cover, aren't kept. The row is one line tall from the first render (chips scroll sideways), so it never moves the results when it loads.
- **Clear** empties both fields and returns to the start screen.
- **Twelve Data requests:** examples and recent analyses are ordinary links, so they can be opened in a new tab, but they're never prefetched: nothing loads until one is picked.

## How metrics are calculated

All calculations are pure functions in `lib/analytics/`.

| Metric | Definition |
| --- | --- |
| Implied probability | Midpoint of YES bid and YES ask: `(yesBid + yesAsk) / 2`. If one side of the book is empty, the last trade price is used, and the dashboard says when that trade happened. History points are estimated the same way from each candle, using the previous trade if none happened in that period. Only shown while a market is open for trading: closed and settled markets show their result instead, and no probability, change, or uncertainty is derived from their last trade. |
| 1h change | Current probability minus the probability in effect exactly 60 minutes ago, in percentage points. Uses 1-minute candles. Kalshi only records a candle when something changes, so the comparison point is the last one at or before that moment; the dashboard shows its time, and notes when it was estimated differently from the current probability (midpoint vs. last trade). |
| 24h change | Same as the 1h change, against the probability in effect exactly 24 hours ago, from the hour of 1-minute candles before that moment. |
| Uncertainty | Binary entropy `H(p) = −p·log₂p − (1−p)·log₂(1−p)`, scaled to 0–100. 100 at 50%, 0 at 0% or 100%. Labeled high from 80 (about 24–76%), moderate from 40 (about 8–92%), and low below that. The score is the same on either side of 50% (70% scores like 30%, both 88), so the label names the side the market favors, e.g. "High — leans YES, but far from certain", and says "close to a coin flip" only from 40% to 60%. |
| Realized volatility | Sample standard deviation of the last 30 daily log returns, annualized with √252. Uses completed sessions only: while the market is open, today's unfinished bar is left out (the daily close chart leaves it out too). |
| Relative volume | The latest session's volume as a percentage of average volume. Not shown while the market is open: today's volume is still accumulating, and on Twelve Data's free plan it can miss part of the market, so it isn't comparable with the average until the close. |
| Alignment | The two hourly series are merged on the union of their timestamps, each carrying forward its last value (an as-of join). Stock bars are stamped at their close time; for US stocks the shortened last bar of the day is stamped at the 4:00 PM New York close. Hourly bars are built from Twelve Data's 30-minute bars, grouped the same way Twelve Data groups its own hourly bars. |

## Research section

The Research section measures how Kalshi probability changes relate to stock returns. Correlation is not causation, and nothing here is a prediction or a trading signal: other news can move both at once.

### How the data is lined up

The comparison chart above carries each series forward, so the stock looks flat overnight while Kalshi keeps moving. That's fine for a picture but would distort statistics, so research compares the two **only at moments where both have a real observation**:

- **Hourly:** the stock's top-of-hour closes during trading hours (10:00 AM to 4:00 PM New York), from 30-minute bars. Kalshi's hourly candles end on the hour, so these line up exactly; Twelve Data's own hourly bars close at :30 and never would.
- **Daily:** each session's close. The actual close time comes from the 30-minute bars, so early-close days (e.g. 1:00 PM) are read at the right moment.
- **Kalshi's value** at each of those moments is the YES bid/ask midpoint in effect then. Kalshi only writes a candle when something changes (every gap checked reopened at the previous close), so a quiet hour's value is the last candle's close, not a guess.

Left out, and counted on the page:

- **Intervals that span time the stock wasn't trading** (hourly mode: overnight, weekends, holidays, halts). Hourly results are intraday only, so Kalshi moves on overnight news, and the first half hour (9:30–10:00, which has no Kalshi value at 9:30), are not included there. Daily close-to-close returns include overnight moves.
- **Kalshi values estimated from the last trade** (when the book is one-sided). The trade may be hours or days old.
- **Times before Kalshi's first candle** in the loaded history, and **after the market's close time**.
- **Stock bars that are still forming** (or closed less than 5 minutes ago).

### Metrics

| Metric | Definition |
| --- | --- |
| Changes | For each interval between consecutive observations, one grid slot apart (one trading hour, or consecutive sessions): the Kalshi probability change in percentage points, and the stock's log return `ln(P₁/P₀)`. |
| Lead-lag | Pearson correlation of the Kalshi change in slot *s* with the stock return in slot *s + k*, for *k* from −3 to +3 hours (hourly) or −5 to +5 trading days (daily). **Positive *k*: Kalshi moved first. Negative *k*: the stock moved first.** Lags never pair across a gap (e.g. overnight). Each bar has dashed marks at ±1.96/√n for its own number of pairs: the rough 95% range if there were no relationship, assuming independent observations. With 7 or 11 lags, one crossing its range by chance alone isn't unusual (about 30% or 43% odds), and the chart says so. |
| Rolling correlation | Same-interval correlation over the last 18 hourly intervals (about 3 sessions) or 20 daily intervals (about a month). Shown only with at least 10 more intervals than one window. |
| Event study | A jump is a Kalshi change of at least the chosen size (1, 2, 3, 5, or 10 pp; default 2 pp hourly, 3 pp daily) in one interval. For each jump, the stock's cumulative log return from the close before the jump, over 6 bars (hourly) or 5 sessions (daily) each side, measured in trading bars, so a window can span a night or weekend. Rises and falls are averaged separately. A jump within that many bars of an earlier one, or too close to the edge of the data, is skipped and counted. The **baseline** is the same path averaged over every window of the same length in the period, jump or not: the stock's normal drift, to compare the jump paths with. |
| Sample size | Every result shows its *n*. Fewer than 10 pairs: no correlation is reported. Fewer than 30: flagged as a small sample. Fewer than 10 non-zero Kalshi changes: flagged, because a few moves decide the result. Fewer than 10 jumps: flagged as too few to generalize. |

**Reading the sign.** Every correlation and event-study direction depends on what YES means for the chosen market. Positive means the stock tended to rise when the chance of YES rose; if YES is bad news for the stock, negative values are what you'd expect. The page quotes the market's YES label next to each chart.

### Data limitations

- **Most Kalshi hourly changes are zero, and moves come in 0.5 pp steps** (1¢ ticks, midpoint). In one check of the Fed October market, 104 of 384 intraday hours over 90 days moved at all. Correlations can rest on a few moves, and event studies often have fewer than 10 jumps.
- **Typical sample sizes:** 7 days hourly ≈ 30 intervals, 30 days hourly ≈ 120, 90 days hourly ≈ 370, 30 days daily ≈ 20, 90 days daily ≈ 60. The daily view isn't offered for 7 days (about 5 closes).
- **Market lifetime:** a market younger than the window covers less of it (the page shows the actual date range). Stock data covers the last ~90 days, so a market that settled before then won't overlap.
- **History depth:** Kalshi returns at most 10,000 candles per request, so 90 days (plus a week before, to know the probability in effect when the window starts) is one request of hourly candles. The Twelve Data free plan returns up to 900 30-minute bars (about 70 sessions) of regular-hours data.

### Market-adjusted returns

A Kalshi move and a stock move in the same hour can both be the whole market moving. **Returns: Market-adjusted** takes out what a benchmark explains, so what's left is how the stock moved differently from the market. It applies to the same-interval correlation, lead-lag, rolling correlation, and the event study. Raw is the default and is unchanged.

- **Benchmark:** SPY by default; any US stock or ETF can be picked in the Research section with the same search field as the form (e.g. QQQ, or a sector ETF such as XLK or XLF). It resets to SPY for each analysis and isn't part of the shareable link. Its bars are read at exactly the stock's observation times (top-of-hour closes, and session closes stamped the same way as the stock's); an interval without a benchmark price at both ends is left out of the adjusted results and counted. Only benchmark bars that had closed at least 5 minutes before they were fetched are used.
- **Market model:** OLS of the stock's log return on the benchmark's, *r = α + β·r_benchmark*, over **every interval in the loaded 90 days** at the chosen resolution where both have prices (Kalshi isn't needed): about 380 hourly or 62 daily intervals. The page shows β (with a 95% interval), α, R², and n, and says that they come from the full 90 days whatever window is selected. The **abnormal return** is *r − α − β·r_benchmark*.
- **Event study:** its β and α are fitted the same way but leaving out every interval within the event window (6 bars hourly, 5 sessions daily, each side) of every jump at or above the chosen size anywhere in the 90 days, so the jumps being studied don't shape β. Paths are the cumulative abnormal log return, *ln(S/S₀) − β·ln(B/B₀) − α·bars*; the baseline is adjusted the same way. With large or frequent jumps (e.g. daily, 3 pp) too few intervals may be left, and the page says so.
- **Simple excess return**, *r − r_benchmark* (β = 1, α = 0), is shown next to the beta-adjusted and raw results for the same-interval correlation and the event study's end values.
- **Kalshi with the market held fixed:** OLS of the stock's return (%) on the benchmark's return (%) and the Kalshi change (pp) over the selected window, reporting the Kalshi coefficient (stock return per 1 pp), a 95% interval, and a p-value. Standard errors are Newey–West (Bartlett weights, ⌊4(n/100)^{2/9}⌋ lags, 3–5 here) with an HC3-style leverage correction, and the p-value uses a t distribution with n − 3 degrees of freedom:
  - Stock moves are larger in the hours news moves Kalshi, so ordinary standard errors (which assume constant variance) are too small.
  - Kalshi often reprices over several hours, and the Newey–West sum covers that autocorrelation. Lags pair intervals exactly that many grid slots apart, so no lag reaches across a night or a missing session.
  - Kalshi doesn't move in most hours, so the coefficient rests on the few intervals where it did. OLS fits those high-leverage points closely, which makes their residuals understate the noise; dividing each residual by (1 − leverage), as HC3 does, corrects for that.
  - The p-value isn't shown when Kalshi moved in fewer than 10 intervals. Clustering by day was not used (about 5 clusters in 7 days), nor a bootstrap (lumpy with few moves, and its random results would change from one view to the next).

Caveats shown on the page:

- If the event moves the whole market (an index level, the Fed, a recession), adjusting removes the part of the move the stock shares with the market, which may be the very effect being studied. The page flags when Kalshi changes correlate with the benchmark's returns beyond the no-relationship range.
- A benchmark that holds the stock (NVDA is in SPY and QQQ, and a large weight in tech sector ETFs) absorbs part of the stock's own move. A benchmark that explains almost all of it (R² ≥ 0.95, e.g. VOO for SPY) leaves mostly noise, and the page says so. When the stock is the benchmark, adjustment is unavailable.
- Hourly β is intraday (trading hours only) and daily β includes overnight moves, so they differ. For thinly traded stocks the last trade in an hour can be stale, which pulls hourly β toward 0.
- β is assumed stable over the 90 days. Event-study windows span nights and weekends, and β and α apply per bar there too.

### CSV export

**Download CSV** saves the aligned dataset for the selected window and resolution, e.g. `eventlens_NVDA_KXFEDDECISION-26OCT-H25_90d_hourly_2026-09-28.csv`. It has one row per stock observation, including excluded rows with the reason, so the analysis can be redone or filtered differently elsewhere:

| Column | Meaning |
| --- | --- |
| `timestamp_utc`, `timestamp_ny` | Observation time (ISO 8601; New York time with its UTC offset) |
| `resolution` | `hourly` or `daily` |
| `stock_close` | Stock price at that time |
| `kalshi_probability` | Kalshi probability in effect (0–1); empty before the first candle |
| `kalshi_source` | `midpoint` or `last_price` |
| `kalshi_as_of_utc` | When the Kalshi candle that value comes from ended. Filter `kalshi_as_of_utc == timestamp_utc` to keep only hours where Kalshi wrote a candle. |
| `kalshi_valid`, `kalshi_exclusion` | Whether the Kalshi value is usable, and why not (`before_kalshi`, `market_closed`, `kalshi_last_price`) |
| `interval_valid`, `interval_exclusion` | Whether the interval ending at this row is used, and why not (`first_row`, `non_trading`, or a Kalshi reason) |
| `prob_change_pp`, `stock_log_return` | Changes over the interval ending at this row, filled in whenever both ends have values, even for excluded intervals |
| `benchmark_symbol`, `benchmark_close` | The benchmark in use, and its close at exactly this time (empty if it has no bar then, or the stock is the benchmark) |
| `benchmark_log_return` | The benchmark's log return over the same interval |
| `market_beta`, `market_alpha` | β and α (per interval, as a log return) of the market model from the full 90 days at this resolution; the same on every row |
| `abnormal_log_return`, `excess_log_return` | `stock_log_return − market_alpha − market_beta × benchmark_log_return`, and `stock_log_return − benchmark_log_return` |

```python
import pandas as pd

df = pd.read_csv("eventlens_NVDA_KXFEDDECISION-26OCT-H25_90d_hourly_2026-09-28.csv", parse_dates=["timestamp_utc"])
used = df[df.interval_valid]
print(len(used), used.prob_change_pp.corr(used.stock_log_return))

adjusted = used[used.abnormal_log_return.notna()]
print(len(adjusted), adjusted.prob_change_pp.corr(adjusted.abnormal_log_return))
```

The market model is fitted on all 90 days, so to reproduce β and α, use the 90-day CSV: regress `stock_log_return` on `benchmark_log_return` over rows whose `interval_exclusion` isn't `first_row` or `non_trading` (Kalshi exclusions still count) and that have both returns.

## Project structure

```
app/                  Next.js routes (page.tsx renders the dashboard server-side)
  api/search/         Search API routes: stocks/ and kalshi/ (GET ?q=…)
  api/benchmark/      Research benchmark prices (GET ?symbol=…)
components/           UI components (cards, form, panels)
  analysis/           Loading analyses, shareable links, Copy link, recent analyses
  charts/             Recharts client components
  research/           Research panel (window, resolution, raw or market-adjusted returns, benchmark, analyses, CSV download)
  search/             Stock and Kalshi search fields (comboboxes)
lib/
  kalshi/             Kalshi API client, market search index, normalized types (server-only)
  market-data/        Twelve Data client, symbol lists and search, popular symbols, research benchmarks (server-only)
  analytics/          Pure metric, alignment, research, and regression functions (and the CSV export)
  search/             Search contract: result types, query validation, error responses
  validation.ts       Ticker input validation
  format.ts           Number and date formatting
```

Third-party API calls live in `lib/kalshi` and `lib/market-data`, run only on the server (enforced with `server-only`), and return normalized TypeScript types. The UI never calls third-party APIs directly: the search fields call this app's `/api/search/…` routes, and picking a benchmark calls `/api/benchmark`.

## Security

- `TWELVE_DATA_API_KEY` is read only in server-only code and sent to Twelve Data in an `Authorization` header, never in a URL, so it stays out of browser code, cached request URLs, and logs.
- Ticker inputs are validated on the server before any upstream request. Search queries are validated too (at most 100 characters, no control characters) and never reach an upstream API.
- Users see fixed error messages. Twelve Data's own error text is logged on the server only, with the key redacted.
- Each client IP can run 5 analyses a minute and 30 an hour (`lib/analysis-rate-limit.ts`), pick 5 benchmarks a minute and 30 an hour (`app/api/benchmark/route.ts`), and run 30 searches a minute and 300 an hour in each search field (`app/api/search/*/route.ts`).
- Every upstream request times out after 6 seconds (the daily stock-list download after 45), and the Kalshi and stock sections load independently, so one slow API never hides the other's data.

**How much the rate limit protects you.** The limiter keeps its counts in the server's memory. That is enough to stop one person repeatedly hammering the site, but it is not a hard guarantee:

- On Vercel, each server instance keeps its own counts, and counts reset when an instance restarts. A quiet site usually runs on one warm instance, so the limit mostly holds; under heavier traffic Vercel starts more instances and each one allows its own 5 per minute.
- Limits are per IP. People behind the same IP (an office, a mobile carrier) share one limit, and someone using many IPs can get around it.
- It does not cap total usage across all visitors, so it cannot stop the site as a whole from using up the Twelve Data plan.

For a hard limit, use a shared store such as Upstash Redis (`@upstash/ratelimit`) or a rate-limiting rule in the Vercel Firewall.

## Deploying to Vercel

1. Import the GitHub repository in Vercel.
2. Add `TWELVE_DATA_API_KEY` under **Project → Settings → Environment Variables** (Production, plus Preview if you want preview deployments to show stock data). The key is only read at request time, so the build does not need it. If it is missing, the site still works and shows that stock data isn't set up; the server log explains how to fix it.
3. Deploy. Vercel detects Next.js, installs with pnpm 10 from `pnpm-lock.yaml`, and uses Node.js 24 from `engines`.

The page's server function is capped at 30 seconds (`maxDuration` in `app/page.tsx`), and the search routes at 60, since the first search on a new instance waits for its index. Each instance builds its own search indexes, so every instance that serves a stock search downloads the symbol lists once a day (2 Twelve Data requests). All timestamps are shown in New York time with the zone labeled, regardless of the server's time zone.

## Scope

This is an MVP. It has no trading functionality, user accounts, database, or automatic event-to-stock mapping.
