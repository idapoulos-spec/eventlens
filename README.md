# EventLens

EventLens is a research dashboard that compares [Kalshi](https://kalshi.com) prediction-market data with stock-market data.

Pick a stock or ETF (search by ticker or name, e.g. `NVDA` or "nvidia") and a Kalshi market (search by keyword, e.g. "fed october", or paste a market ticker such as `KXFEDDECISION-26OCT-H25`), click **Analyze**, and EventLens shows:

- **Kalshi market:** title, implied probability, YES bid / ask, last price, 24-hour volume, open interest, 1-hour and 24-hour probability change, and an event-uncertainty score
- **Stock:** current price, daily change, volume (compared with average volume once the market has closed), and 30-day realized volatility (via [Twelve Data](https://twelvedata.com))
- **Charts:** Kalshi probability vs. stock return over the last 7 days, aligned on timestamps, plus the probability history and ~3 months of daily closes
- **Whole events:** for a Fed decision event ticker (`KXFEDDECISION-26OCT`), the expected rate change across every outcome instead of one market's probability; see [Event analysis](#event-analysis)
- **Research:** how Kalshi probability changes relate to stock returns over 7, 30, 90, or 180 days, a year, or the market's whole life (up to 540 days; hourly or daily; 90 days hourly by default): lead-lag correlation, rolling correlation, and an event study around Kalshi jumps, on raw or market-adjusted returns (net of SPY or another benchmark), with significance tests built for this data (one primary test, with diagnostics of how much it rests on a few hours or sessions; p-values and 95% intervals for every lag and event-study bar; Holm and Benjamini–Hochberg corrections), sample sizes, caveats, and a CSV export of the aligned data

- **In plain English:** a short summary at the top of Research and of a scan's results, in everyday words, with an evidence rating (Not enough data, No clear link, Weak, Moderate, or Strong) and definitions of the terms it uses; see [In plain English](#in-plain-english)
- **Scan:** one stock against many Kalshi events at once (a series, every stored event, or a list), the same primary test on each, ranked with Holm and Benjamini–Hochberg corrections across the whole scan, as exploratory leads; see [Scan](#scan)

> Experimental market-research tool. Metrics are informational and are not investment recommendations.

The site is private: visitors sign in with an access password (see [Access](#access)).

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

The free Twelve Data plan allows 8 requests per minute and 800 per day. Each analysis uses 3 (quote, 30-minute bars, daily bars). Current quotes from Twelve Data and Kalshi are fetched fresh on every request. Twelve Data price history is kept in the server's memory for 60 seconds after it was fetched, so re-analyzing the same ticker within a minute uses only 1; after that it's always fetched again, never served from an older copy. (Next.js's data cache isn't used for it: after a quiet period it would serve the last copy, however old, while refreshing in the background, so the page could show bars from days ago as current.) Submitting the analysis that's already on screen again within 60 seconds only scrolls to its results and uses none.

Research's benchmark (SPY by default) adds 2 more (30-minute and daily bars, no quote) when the server doesn't already have it in memory, so an analysis uses 3 or 5. Each server instance keeps a benchmark until its next 30-minute bar has settled (at most about 30 minutes), so SPY costs at most 2 requests per half hour per instance however many analyses run; it isn't requested when the stock is SPY. Picking another benchmark in the Research section costs 2 if the server doesn't have it either, and switching back to one already loaded costs none. Everything else in Research (window, resolution, raw or market-adjusted returns, jump size, the CSV) happens in the browser with data that's already loaded.

Stock search uses 2 requests per server instance per day, however much people type: see [Search](#search).

### Access password (optional locally)

The deployed site asks for an access password (see [Access](#access)). `pnpm dev` skips sign-in while `ACCESS_PASSWORD` is unset, so there's nothing to set up to work locally. To try sign-in locally, add both settings to `.env.local` and restart `pnpm dev`:

```env
ACCESS_PASSWORD=a long passphrase of at least 12 characters
AUTH_SECRET=the output of: openssl rand -base64 32
```

### Run locally

```bash
pnpm dev
```

Open <http://localhost:3000>.

The dev server only listens on `127.0.0.1`, so other devices on your network cannot reach it (or spend your API credits). To test from a phone on the same network, run `pnpm exec next dev -H 0.0.0.0` instead, after setting `ACCESS_PASSWORD` and `AUTH_SECRET` in `.env.local`: otherwise anyone on the network can use it without signing in.

### Other scripts

```bash
pnpm lint    # ESLint
pnpm test    # unit tests (Vitest), without the slow simulations
pnpm test:sim  # the slow simulations: calibration at the longer windows, the fragile warning's rates, and scans (two files at a time; about half an hour)
pnpm build   # production build (includes type checking)
pnpm start   # serve the production build (needs ACCESS_PASSWORD and AUTH_SECRET)
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
- **Whole events:** an open event EventLens can analyze as a whole (see [Event analysis](#event-analysis)) also appears as one result, "Whole event · N outcomes", ahead of its markets.
- **Open markets only.** To analyze a closed or settled market, paste its ticker.

Use a **market** ticker, or a supported event ticker (Fed decisions, see [Event analysis](#event-analysis)); other event and series tickers aren't supported. Market tickers appear in Kalshi market URLs and API responses, and look like `KXFEDDECISION-26OCT-H25` or `KXRECSSNBER-27`. The example buttons in the app use real markets, but markets close over time, so an example may stop working.

### Typed text that isn't a ticker

Some names and keywords also look like tickers ("nvidia", "recession"). Analyzing one would only fail, and would spend Twelve Data requests on the stock side. So when a field's search has already shown that its text isn't a listed ticker, **Analyze** asks to pick from the list instead (e.g. "Pick one from the list, such as NVDA (NVIDIA Corporation)"). Tickers the search hasn't seen go straight through.

## Links, saved studies, and sharing

- **Links:** every analysis has its own URL (`/?stock=NVDA&kalshi=KXFEDDECISION-26OCT-H25`), and it carries every Research setting that changes the results, each left out at its default: `window` (7, 30, 90, 180, 365, or `all`; default 90), `res` (`daily`; default hourly), `returns=raw` (default market-adjusted), `bench` (default SPY), `jump` (the event study's jump size at the resolution shown), and `asof` (below). The address bar follows the settings as you change them (nothing is rewritten on load), so **Copy link** above the results copies exactly the view on screen. A setting a link gets wrong falls back to its default; an `asof` it gets wrong shows an "Invalid input" notice instead of quietly going live. A link's benchmark is loaded by the server in place of SPY, for the same 2 Twelve Data credits. A shared link's tab title names the analysis. Opening a link requires signing in, and then goes straight to the analysis. Back and Forward move between analyses, and the fields follow.
- **As of: freezing the numbers.** An open market's windows end now, so its numbers change as data arrives. `asof=2026-10-07T18:02:10.345Z` (UTC, to the minute, second, or millisecond) ends them at that time instead, or at the market's close (an event's first close) if it had closed by then, with or without the data store. The stock's and the benchmark's bars count as settled at that time, not when they're fetched, so a link frozen at a page's own time gives exactly that page's numbers later (`lib/history/freeze.test.ts` checks this at awkward moments: minutes after a top of the hour, after the close, a weekend, before the open, with the benchmark from memory, store on and off). In Research's controls, **Freeze at this view's time** puts the page's time in the link (no reload, no requests), **As of another time…** loads the analysis as of a New York date and time (about 5 Twelve Data credits, like any analysis), and **Go live** leaves it. A frozen page says so above the results. Only Research (and a whole event's panel) is frozen: the Kalshi market panel, the stock panel, and the 7-day charts always show the latest data.
- **What a frozen link reproduces, and what it can't.** Given the same data, the windows, every setting, the statistics (every bootstrap and simulation starts from a fixed seed), and the data store's Kalshi candles are the same every time. What can still change: Kalshi candles after the store's stored-through time, and all of a market the store doesn't collect, are fetched again from Kalshi (from its archive once a market is archived); stock and benchmark prices aren't stored, so Twelve Data's corrections, late trades in a bar frozen minutes after it closed, a later split (returns unchanged in principle, last digits can move), or a ticker change can change them; in the minutes after 4 PM a live page counts the day's session only once Twelve Data reports the market closed, while a frozen link always counts it; Kalshi's market details are read again; and the statistics run in the browser, where another JavaScript engine can differ in the last digits (almost never visible). Without the data store, a closed market's live windows end now but a frozen link's end at its close, so the panel warns that their numbers can differ. The page and the reports give this list in full (`components/analysis/reproducibility.ts`).
- **Saved studies:** **Save study…** in Research's controls (and on a finished scan) keeps the view as a named link with a note and its main result, frozen at the view's time unless unticked. **Saved studies** (`/studies`, linked from the header) lists them: open, rename, edit the note, delete. They're kept in this browser's `localStorage` only: EventLens doesn't store them on its server, they don't appear on other devices or browsers, and clearing the site's data deletes them. **Export to a file** saves them as JSON (`{"format":"eventlens-saved-studies","version":1,"exportedAt":…,"studies":[…]}`); **Import a file…** adds the ones not already saved, replaces older copies of the same study, skips links already saved, and says how many it added, updated, skipped, or couldn't read. Every stored or imported link is rebuilt through the page's own link parsers, so it can only open an analysis or a scan on this site. At most 200 studies; names up to 120 characters, notes up to 4,000.
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
- **Stock bars that were still forming** when they were fetched (or had closed less than 5 minutes before).

### Metrics

| Metric | Definition |
| --- | --- |
| Changes | For each interval between consecutive observations, one grid slot apart (one trading hour, or consecutive sessions): the Kalshi probability change in percentage points, and the stock's log return `ln(P₁/P₀)`. |
| Lead-lag | Pearson correlation of the Kalshi change in slot *s* with the stock return in slot *s + k*, for *k* from −3 to +3 hours (hourly) or −5 to +5 trading days (daily). **Positive *k*: Kalshi moved first. Negative *k*: the stock moved first.** Lags never pair across a gap (e.g. overnight). Each bar has a 95% interval and a p-value, corrected across the lags (see [Statistical tests](#statistical-tests)). |
| Rolling correlation | Same-interval correlation over the last 18 hourly intervals (about 3 sessions) or 20 daily intervals (about a month). Shown only with at least 10 more intervals than one window. **Descriptive only:** neighboring points share all but one interval, so no significance range is drawn and no claim is made. |
| Event study | A jump is a Kalshi change of at least the chosen size (1, 2, 3, 5, or 10 pp; default 2 pp hourly, 3 pp daily) in one interval. For each jump, the stock's cumulative log return from the close before the jump, over 6 bars (hourly) or 5 sessions (daily) each side, measured in trading bars, so a window can span a night or weekend. Rises and falls are averaged separately. A jump within that many bars of an earlier one, or too close to the edge of the data, is skipped and counted. The **baseline** is the same path averaged over every window of the same length in the period, jump or not: the stock's normal drift, to compare the jump paths with. Each bar has a 95% interval and a test against the baseline, and each direction a test of the whole path (see [Statistical tests](#statistical-tests)). |
| Sample size | Every result shows its *n*. Fewer than 10 pairs: no correlation is reported. Fewer than 30: flagged as a small sample. Fewer than 10 non-zero Kalshi changes: flagged, because a few moves decide the result. Fewer than 8 sessions (hourly) or runs of days (daily): correlations get no p-value or interval. Fewer than 5 jumps in a direction: no intervals or p-values for it; 5–9: flagged as rough, with the smallest p-value possible. |

**Reading the sign.** Every correlation and event-study direction depends on what YES means for the chosen market. Positive means the stock tended to rise when the chance of YES rose; if YES is bad news for the stock, negative values are what you'd expect. The page quotes the market's YES label next to each chart.

### Data limitations

- **Most Kalshi hourly changes are zero, and moves come in 0.5 pp steps** (1¢ ticks, midpoint). In one check of the Fed October market, 104 of 384 intraday hours over 90 days moved at all. Correlations can rest on a few moves, and event studies often have fewer than 10 jumps.
- **Typical sample sizes:** 7 days hourly ≈ 30 intervals, 30 days hourly ≈ 120, 90 days hourly ≈ 370, 180 days ≈ 740, a year ≈ 1,500, and All at its 540-day cap ≈ 2,200; daily, 30 days ≈ 20, 90 days ≈ 60, 180 days ≈ 124, a year ≈ 252, 540 days ≈ 372. The daily view isn't offered for 7 days (about 5 closes).
- **Market lifetime:** no window reaches back before the market opened (for an event, its first outcome): a younger market's window covers only its life, and the page says so (*"This market opened on Mar 3, 2026, so the 1Y window covers only 225 days"*). A longer window that's no longer than 90 days for this market is the 90-day one, and the page says that too. **All** is the market's whole life, up to 540 days, the most one Twelve Data request of 30-minute bars holds; the page says when it's capped. Without the [data store](#data-store), a market that closed before Kalshi's archive cutoff can't be found; with it, a closed market's windows end at its close.
- **History depth:** a Twelve Data request returns up to 5,000 bars for 1 credit, and the free plan serves that much: 4,828 30-minute bars for SPY over the 540 days to 2026-10-14 (checked live, 1 credit). So the stock's and the benchmark's bars for every window come in the same 4 requests as before. Kalshi's history for the longer windows comes from the store; without it, from live or archive requests of at most 4,800 hourly candles each (the archive allows 5,000, the live endpoint 10,000).

### Longer windows

**7D, 30D, and 90D** read the 90 days the page loads with, exactly as before (`lib/history/research-golden.test.ts` pins their rows and results end to end, through the loaders, as they were before the longer windows were added). **180D, 1Y, and All** read a longer history that streams in after the page's first render, so they never slow it down:

- **Credits.** Every window costs the same: 5 Twelve Data credits per analysis (1 if the same stock was analyzed in the last minute and SPY is cached), plus 2 per other benchmark. The stock's 30-minute and daily requests already reach back to the market's open (at most 540 days, at least 100), and the benchmark's to 540 days, so one SPY download serves every analysis; a request costs 1 credit whatever its length up to 5,000 bars.
- **Kalshi** comes from the store first (a market's 540 days is about 6,500 stored candles, read in about 0.25 s; a whole event's about 26,000 in 0.6 s, measured on the production store), with a live tail after it; without the store, from live or archive requests of at most 4,800 hours. It gives up after 15 seconds, and the page then says the longer windows couldn't be loaded; 7–90D still work.
- **The market model** is fitted on the window itself (up to about 2,200 hourly intervals), not the 90 days, and the page says so.
- **Splits.** Twelve Data's daily bars are split-adjusted and its intraday bars aren't, so a split in the loaded range would put a jump in hourly event-study paths that span a night. Sessions whose last 30-minute close is more than 25% off the day's daily close are scaled onto the daily bars' basis (`adjustIntradayForSplits`); without a split nothing changes.

**Keeping the page responsive** (`scripts/bench-research.ts`; Node on an Apple-silicon Mac, median of 5, simulated rows at each length). The 7, 30, and 90-day windows are computed as a toggle happens; the rest runs after the main results render, a slice at a time, so clicks and scrolling are handled in between.

| Window | Window, benchmark, or returns toggle | Jump size | Longer window, total (slices up to) | Detectable size | Leave-one-out, total (slices up to) |
| --- | --- | --- | --- | --- | --- |
| 30D hourly | 66 ms | 1 ms | — | 24 ms | 93 ms (9) |
| 90D hourly | 120 ms | 9 ms | — | 38 ms | 154 ms (14) |
| 180D hourly | — | — | 246 ms (25) | 58 ms | 315 ms (29) |
| 1Y hourly | — | — | 500 ms (54) | 104 ms | 657 ms (60) |
| All hourly (540 days) | — | — | 730 ms (79) | 145 ms | 971 ms (89) |
| 90D daily | 36 ms | 0 ms | — | 23 ms | 27 ms (3) |
| All daily (540 days) | — | — | 204 ms (14) | 41 ms | 147 ms (14) |

So the page never goes more than about 145 ms without the main thread. Measured in the browser too (a production build in headless Chrome on the same Mac, TLT against KXFEDDECISION-26DEC, 2026-10-19), from a click to the results on screen: 65–225 ms for the 7, 30, and 90-day windows; 0.40, 0.74, and 0.78 s for 180D, 1Y, and All, with the detectable size and leave-one-out check done by 0.70, 1.32, and 1.37 s; a new jump size in 66 ms at 90D and 0.50 s at 1Y. The longest single main-thread task was 145 ms (switching to 90D, computed in one go), and the longest slice 108 ms. A Web Worker was tried first, but Next.js 16.3's Turbopack emits a `new Worker(new URL(…, import.meta.url))` target as a static file rather than a bundle, so the worker can't load its imports. The slices come from writing the lead-lag tests, the market model's tests, and the leave-one-out check as steps; run to the end, they give exactly the plain results.

**90 days stays the default.** The rule was fixed before measuring (feat/long-windows plan): switch to the shortest of 180D and 1Y that (a) at least half of the open KXFEDDECISION markets and events have in full, (b) raises the median effective number of hourly Kalshi moves to at least 1.5× the 90-day one, (c) passes its simulations, and (d) keeps every toggle under 300 ms. `scripts/measure-windows.ts` measured (a) and (b) on the store on 2026-10-19, Kalshi only (no stock data, no results): all 11 open events and all 55 open markets have a full year (they opened in Sep–Oct 2025), but the median effective number of moves barely grows: 16.8 at 90 days, 20.1 at 180 (×1.20), and 21.2 at a year (×1.26) for events; 10.3, 9.8 (×0.95), and 11.6 (×1.12) for single markets. A few large moves dominate whatever the length, so older months add little information about Kalshi's side while adding stock noise and assuming a stable beta for longer. (c) passes for 180D but not for 1Y, whose daily intervals under-covered (below), and (d) passes for both. The simulations' gain in power (below) assumes Kalshi keeps moving as much in older months as recently, which these markets don't.

### Market-adjusted returns

A Kalshi move and a stock move in the same hour can both be the whole market moving. **Returns: Market-adjusted** takes out what a benchmark explains, so what's left is how the stock moved differently from the market. It applies to the same-interval correlation, lead-lag, rolling correlation, and the event study. **Market-adjusted is the default**, since the primary test always uses market-adjusted returns. When adjustment isn't possible (the stock is the benchmark, the benchmark didn't load, or there are too few prices to estimate beta), the page shows raw returns and says why under the toggles; picking Raw shows the stock's own returns.

- **Benchmark:** SPY by default; any US stock or ETF can be picked in the Research section with the same search field as the form (e.g. QQQ, or a sector ETF such as XLK or XLF). It resets to SPY for each analysis and isn't part of the shareable link. Its bars are read at exactly the stock's observation times (top-of-hour closes, and session closes stamped the same way as the stock's); an interval without a benchmark price at both ends is left out of the adjusted results and counted. Only benchmark bars that had closed at least 5 minutes before they were fetched are used.
- **Market model:** OLS of the stock's log return on the benchmark's, *r = α + β·r_benchmark*, over **every interval in the loaded 90 days** for the 7, 30, and 90-day windows, and **every interval of the window itself** for the longer ones, at the chosen resolution where both have prices (Kalshi isn't needed): about 380 hourly or 62 daily intervals for 90 days, up to about 2,200 or 372 for All. The page shows β (with a 95% interval), α, R², and n, and says where they come from. The **abnormal return** is *r − α − β·r_benchmark*.
- **Event study:** its β and α are fitted the same way but leaving out every interval within the event window (6 bars hourly, 5 sessions daily, each side) of every jump at or above the chosen size anywhere in the market model's sample, so the jumps being studied don't shape β. Paths are the cumulative abnormal log return, *ln(S/S₀) − β·ln(B/B₀) − α·bars*; the baseline is adjusted the same way. With large or frequent jumps (e.g. daily, 3 pp) too few intervals may be left, and the page says so.
- **Simple excess return**, *r − r_benchmark* (β = 1, α = 0), is shown next to the beta-adjusted and raw results for the same-interval correlation and the event study's end values.
- **Kalshi with the market held fixed:** OLS of the stock's return (%) on the benchmark's return (%) and the Kalshi change (pp) over the selected window, reporting the Kalshi coefficient (stock return per 1 pp), a 95% interval, and a p-value. The p-value and interval come from **the same wild cluster bootstrap as the primary test** (see [Statistical tests](#statistical-tests)), with every coefficient, the benchmark's included, refitted in every draw. Its statistic is the coefficient's t with Newey–West standard errors (Bartlett weights, ⌊4(n/100)^{2/9}⌋ lags, 3–5 here) and an HC3-style leverage correction:
  - Stock moves are larger in the hours news moves Kalshi, so ordinary standard errors (which assume constant variance) are too small.
  - Kalshi often reprices over several hours, and the Newey–West sum covers that autocorrelation. Lags pair intervals exactly that many grid slots apart, so no lag reaches across a night or a missing session.
  - Kalshi doesn't move in most hours, so the coefficient rests on the few intervals where it did. OLS fits those high-leverage points closely, which makes their residuals understate the noise; dividing each residual by (1 − leverage), as HC3 does, corrects for that.
  - It's a cross-check of the primary test (which uses β from the market model's sample), shown with an uncorrected p-value. With fewer than 8 sessions (or runs of days) there's no p-value or interval, as for the correlations.
  - **Newey–West cross-check:** the same t read from a t distribution with n − 3 degrees of freedom is shown next to it (not when Kalshi moved in fewer than 10 intervals, or when the bootstrap gives no p-value). That large-sample approximation rejects too often when the stock is more volatile in the hours Kalshi moves: in the test suite's simulations with 21 hourly sessions and no relationship, 8.0% of data sets (32 of 400, ± 1.4), against 4.5% for the bootstrap on the same data sets (see [Statistical tests](#statistical-tests)).

Caveats shown on the page:

- If the event moves the whole market (an index level, the Fed, a recession), adjusting removes the part of the move the stock shares with the market, which may be the very effect being studied. The page flags when Kalshi changes correlate with the benchmark's returns (wild bootstrap p < 0.05, uncorrected).
- A benchmark that holds the stock (NVDA is in SPY and QQQ, and a large weight in tech sector ETFs) absorbs part of the stock's own move. A benchmark that explains almost all of it (R² ≥ 0.95, e.g. VOO for SPY) leaves mostly noise, and the page says so. When the stock is the benchmark, adjustment is unavailable.
- Hourly β is intraday (trading hours only) and daily β includes overnight moves, so they differ. For thinly traded stocks the last trade in an hour can be stale, which pulls hourly β toward 0.
- β is assumed stable over the market model's sample: the 90 days, or up to 540 days for the longer windows, where the page adds that caveat. Event-study windows span nights and weekends, and β and α apply per bar there too.

### Statistical tests

The data is hard on textbook statistics: Kalshi's hourly change is zero most of the time and moves in 0.5 pp steps, Kalshi often reprices over several hours, the stock is more volatile in the hours news moves Kalshi, and samples are small. The tests below are built for that, and everything is computed in the browser from data already on the page, with no extra API calls.

**One primary test.** The page is set up to answer one question, fixed before looking at any data: *in the selected window and resolution, do Kalshi changes go with the stock's market-adjusted returns in the same interval?* (lag 0, abnormal returns against the benchmark). It's judged on its own p-value at 5% and shown at the top of the Research section whichever returns are selected. β and α are refitted in every bootstrap draw, so the test allows for β being estimated (below). When the result isn't significant, the page also shows the smallest correlation this sample could detect (below). Everything else is labeled exploratory. When market adjustment isn't possible (the stock is the benchmark, or the benchmark didn't load or has too few prices), there's no primary test, and the page says so instead of falling back to raw returns (the charts below fall back to raw returns, and say so). Switching windows, resolutions, benchmarks, or jump sizes after seeing the results isn't corrected for, and the page says that too.

**One result shape.** Every test returns the same fields (`TestResult` in `lib/analytics/inference.ts`): estimate, 95% interval, p-value, Holm- and Benjamini–Hochberg-adjusted p-values within its family, role (primary or exploratory), method with its resampling details (what was resampled, how many, how many draws, the smallest possible p), n, effective n where it applies, and why a p-value or interval is withheld. The page shows them with the same columns and wording everywhere.

| Analysis | Estimate | p-value | 95% interval |
| --- | --- | --- | --- |
| Correlation at each lag, and the primary test | Pearson r | Wild cluster bootstrap | Every slope the same test wouldn't reject, shown on the correlation scale |
| Event study, each bar | Mean path after jumps minus the baseline (%) | Sign-flip test over events | Bootstrap-t over events |
| Event study, whole path | — | Sign-flip test of the largest \|t\| over the bars | — |
| Kalshi with the market held fixed (cross-check) | Regression coefficient | Wild cluster bootstrap, every coefficient refitted (Newey–West t shown as a cross-check) | Every value the same test wouldn't reject |

**Correlations: wild cluster bootstrap with the null imposed** (`lib/analytics/correlation-test.ts`).

- Kalshi's changes stay exactly as observed, zeros and steps included. The stock's returns are rebuilt under "no relationship" as their mean plus each residual times one random weight per block, from Webb's six-point distribution. Blocks are New York trading sessions (hourly) or runs of *b* consecutive trading days (daily; *b* = max(2, ⌊4(n/100)^{2/9}⌋): 2 for 30 days, 3 for 90). That keeps Kalshi's autocorrelation, the stock's volatility in every hour (including the hours Kalshi moved), and any dependence within a session, and removes only a link in direction.
- The statistic is the slope's t with the same Newey–West + HC3 standard errors as the regression above. The p-value is the share of 999 draws at least as extreme as the data; the page shows the number of sessions (or runs) and the smallest possible p (0.001).
- The interval is every slope the same bootstrap wouldn't reject at 5%, so it excludes zero exactly when p < 0.05. Each draw's t is a closed-form function of the slope being tested, so the interval costs no extra draws. It's shown as a correlation (slope × *s_x*/*s_y*), clamped to ±1. An interval that reaches ±1 means Kalshi's moves at that lag fall in too few sessions to pin it down.
- **With fewer than 8 sessions (or runs of days), no p-value or interval is shown**, and the page says how many there were: the 7-day window has about 5 sessions. The cutoff of 8 was chosen in development runs, which aren't part of the test suite. The tested power figures under Validation show that detection is already weak with 10 sessions.
- **On market-adjusted returns, β and α are refitted in every draw** (`lib/analytics/wild-bootstrap.ts`), for the primary test and every lag of the market-adjusted lead-lag chart. Each draw rebuilds the stock's returns over the whole market model sample (every interval of the loaded 90 days, or of a longer window, each of its sessions with its own weight), refits the market model, recomputes the abnormal returns, and recomputes the correlation's t. Under "slope = θ₀" the rebuilt returns carry an effect θ₀/κ along Kalshi's changes, where κ is the share of Kalshi's variation the market model leaves in place: when Kalshi moves with the benchmark, the market model absorbs part of any effect, so the abnormal returns show only κ of it. Everything stays a closed-form function of the slope being tested, so this costs a few milliseconds. `wild-bootstrap.test.ts` checks the closed form against refitting both regressions with `ols` draw by draw, and checks that raw-returns results are exactly as before. The regression above uses the same engine with the benchmark's return as a second regressor.
- Treating β as known was conservative, not optimistic: β is fitted on 90 days that include the window, so its error partly cancels the noise the test sees. In the simulations below, the fixed-β version came out below 0.05 in only 1.7% of data sets over 90 hourly days when Kalshi tracks the benchmark; refitting brings that to 4.7%.
- Effective n is Bartlett's *n* / (1 + 2 Σ ρₓ(j) ρᵧ(j)) over the Newey–West lags, autocorrelations pairing slots exactly *j* apart. It's for reading the sample size; the tests don't use it.

**Smallest detectable correlation** (`lib/analytics/power.ts`). When the primary test isn't significant, the page says how large a same-interval correlation this sample could have detected 80% of the time, so a non-significant result isn't read as evidence of no link:

- 999 simulated versions of the sample keep Kalshi's changes, the benchmark's returns, the sessions, and the stock's residual volatility (the market model's residuals, each session with a fresh Webb weight), with an effect built in along Kalshi's changes. Each is tested the way the page tests the real sample: α and β refitted, the same statistic, and a bootstrap critical value. Rerunning a 999-draw bootstrap inside each would cost a million draws, so critical values use the **warp-speed method** (Giacomini, Politis & White 2013): one inner bootstrap draw per simulated sample, from its own restricted residuals.
- **One sample's volatility is itself uncertain**: with heavy-tailed returns, the volatility in the few hours Kalshi moved is estimated from a handful of intervals. Taking it as known was optimistic: in development runs (not in the test suite), effects of the size it reported were detected only about 71–77% of the time in fresh samples. So the power is averaged over that uncertainty: the statistic's score variance is resampled by session (200 resamples), and since the test is scale-free, noise *k* times larger is the same as an effect *k* times smaller. Few sessions or a few dominant hours then widen the spread and raise the detectable size.
- The figure is the smallest |r| reaching 80% in both directions, on the scale *r* = θ·*s_x* / √(θ²*s_x*² + *s_y*²). It's a rough guide, and the page says so. **Above ±0.8 it isn't given as a number**: there the power curve flattens and the simulation stops being reliable, so the page says only correlations stronger than about ±0.8 could be detected. With 30 days of daily data that's the usual case, and **when a 30-day daily window does get a number, the page says it's unreliable**, with the measured rate below.
- It's computed only when the primary result isn't significant, from data already on the page.

**How much the primary result rests on a few hours** (`lib/analytics/fragility.ts`). Next to the primary test, and computed from its own bootstrap, so they describe exactly what the test used. They're diagnostics, not tests: they say how much the result rests on a few intervals or sessions, not whether it's right.

- **Kalshi's movement:** the share of the Kalshi variable's variation (Σx̌², x̌ the change net of its mean) in the largest interval and the largest 5, and how many equal intervals that's as concentrated as. The correlation's slope is a weighted mean of each interval's slope with weights x̌²/Σx̌², so Kish's effective number, (Σw)²/Σw², is how many intervals it effectively rests on.
- **Sessions:** each session's (or run of days') score s = Σ q·a over its intervals, where a is the abnormal return and q the Kalshi change net of what the market model absorbs; Σs is the estimate's numerator, and under "no link" the bootstrap's numerator is Σ s·w with one Webb weight w per session, so its variance is Σs². The page shows the shares of Σs² in the top 1, 5, and 10 sessions and their effective number, as a description; it isn't part of the warning (below).
- **The most influential sessions and hours,** with their New York times (to look up the news), Kalshi changes, abnormal returns, and which way each pushed the estimate.
- **Leave one out:** the primary test rerun from scratch without each of the 10 most influential sessions in turn (ranked by score share before any rerun; α and β refitted without it), with the range of estimates and p-values and whether the decision at 5% ever changes; then without all 10 at once, for information. Reruns left with fewer than 8 sessions get no p-value.
- **The fragile warning** uses thresholds fixed before any result was seen: fewer than 10 effective intervals of movement (F1; where the page already says a few moves decide), or a decision at 5% that changes when one of the 10 most influential sessions is left out (F3; p crossing 0.05 either way, or a significant estimate changing sign). The warning names which tripped. A p-value near 0.05 can also cross from Monte Carlo error alone (about ±0.007 with 999 draws).
- **It also comes on by chance,** and the page says how often: in hourly simulations with no real relationship it came on in 11.5% of data sets over a year and 13.0% over 180 days, but 22.5% over 90 days and 75.0% over 30 days, where few intervals carry Kalshi's movement (table below).
- **Changed on 2026-10-19 from the pre-set thresholds:** a third check, fewer than 8 effective sessions (F2; below which the page shows no p-value at all), was dropped from the warning; the effective number of sessions is still shown as a description. In simulations with no real relationship F2 fired in 98.5% of data sets at 90 days and 61.0% at a year, because most sessions have no Kalshi movement, so the score always sits in a few of them and as a warning it carried no information. The decision was based only on simulated data, not on any real result, and the page notes it.

**Event study: sign flips and bootstrap-t** (`lib/analytics/event-tests.ts`).

- Each bar's test asks whether the paths after jumps differ from the baseline. Each event's deviation from the baseline is flipped in sign at random (all bars of an event together) and the t statistic recomputed: if jumps had nothing to do with the stock's direction, a deviation would be as likely up as down, however volatile the stock was around the jump. Up to 14 events, every sign pattern is enumerated, so the p-value is exact; beyond that, 4,999 random patterns. The smallest possible p is 2/2ⁿ, so **5 events can never get below 0.0625**, and the page says so.
- The whole-path test, one per direction, compares the largest |t| over the bars (12 hourly, 10 daily; not the reference bar −1, which is zero by construction) with the same sign flips.
- Intervals are a bootstrap-t over events (1,999 resamples). With fewer than 5 events in a direction there are no intervals or p-values; with 5–9 they're flagged as rough, since bootstrap-t intervals over so few events can be wide and lopsided.

**Multiple testing.** Each chart is one family, corrected with both Holm (keeps the chance of any false positive in the family at 5%) and Benjamini–Hochberg (keeps the expected share of false positives among the results that pass at 5%). Tables show raw, Holm, and BH p-values and a "Passes" column ("Holm and BH", "BH only", or "—"); the lead-lag chart marks passing lags with a filled (Holm) or hollow (BH only) diamond, and the event-study chart fills the dots of bars that pass BH.

| Family | Tests | Correction |
| --- | --- | --- |
| Primary | 1 | None: judged on its own p-value |
| Lead-lag | Every exploratory lag on the chart: 7 hourly or 11 daily on raw returns; 6 or 10 on market-adjusted returns, where lag 0 is the primary test | Holm and BH |
| Event-study bars | Every bar but the reference bar, rises and falls together: 24 hourly, 20 daily (12 or 10 when only one direction has at least 5 jumps) | Holm and BH |
| Event-study paths | Rises and falls: 2 (1, so uncorrected, when only one direction has at least 5 jumps) | Holm and BH |
| Cross-checks | Kalshi with the market held fixed; Kalshi vs. the benchmark (the flag in Market adjustment) | None, labeled uncorrected |

**Reproducible.** Resampling uses mulberry32 seeded from a fixed seed (`RESAMPLING_SEED`) and a label per method, so the same data and settings give the same numbers on every load and every device, and a lag's result doesn't depend on which other lags are tested. Monte Carlo error remains: with 999 draws, a p-value near 0.05 has a standard error of √(0.05 × 0.95 / 999) ≈ 0.007, so another seed could move a borderline result across 0.05.

**Validation.** `lib/analytics/correlation-test.test.ts` and `lib/analytics/event-tests.test.ts` run simulations with fixed seeds, so every figure below comes straight from those tests and is the same on every run. The simulated Kalshi changes are zero in about 80% of hours (80.2% of 12,600 hours in the test that checks it), move in 0.5 pp steps, and tend to continue; the stock's returns have heavy tails and volatility that varies by day, by hour of day (U-shaped), and on news days. In the "shared volatility" variant, news days and big Kalshi moves come with a more volatile stock but no link in direction, the case that fools simple tests.

Each rate is the share of simulated data sets, with the count in brackets. **± is one Monte Carlo standard error**, √(p(1 − p)/n), and the range is a 95% Wilson interval. With a few hundred data sets, a rate within about 2.5 points of 5% can't be told apart from 5%. The tests use 199 bootstrap draws per data set to stay fast (the page uses 999).

False positives: the share of data sets with p < 0.05 at lag 0 when there is no relationship.

| Setting | Data sets | p < 0.05 | ± SE | 95% range | Test fails if |
| --- | --- | --- | --- | --- | --- |
| Hourly, 21 sessions (about 30 days), independent | 400 | 3.5% (14) | 0.9 | 2.1–5.8% | below 2% or above 7.5% |
| Hourly, 21 sessions, shared volatility | 400 | 3.2% (13) | 0.9 | 1.9–5.5% | below 2% or above 7.5% |
| Daily, 62 days (about 90 days), shared volatility | 300 | **6.0% (18)** | 1.4 | 3.8–9.3% | above 7.5% |
| Daily, 20 days (about 30 days), shared volatility | 300 | 3.3% (10) | 1.0 | 1.8–6.0% | above 7.5% |

**The daily 62-day setting slightly over-rejects: 6.0% of data sets came out below 0.05, not 5%.** That's within Monte Carlo error (0.7 standard errors above 5%, and the 95% range includes 5%), so 300 data sets can't show whether the true rate is above 5%. But it isn't conservative either, and the test only fails above 7.5%. The other three settings came out below 5%.

- **Multiple testing:** across the 7 hourly lags (21 sessions, shared volatility, 200 data sets), at least one lag had an uncorrected p < 0.05 in 27.0% (54) ± 3.1 (95% range 21.3–33.5%) of data sets with no relationship. After Holm, 3.0% (6) ± 1.2 (1.4–6.4%). The test fails if Holm goes above 7.5% or the uncorrected rate below 12%. BH isn't simulated.
- **Intervals:** the 95% interval covered the true slope in 95.0% (190 of 200) ± 1.5 (91.0–97.3%) of data sets (62 sessions, shared volatility, slope 0.3% per pp). The test fails outside 92–98.5%.
- **Detection:** both checks use strong built-in relationships. A same-hour slope of 0.6% per pp (21 sessions) was detected in 99 of 100 data sets (99.0% ± 1.0), and the same slope two hours later (62 sessions) passed Holm at lag +2 in 100 of 100. Each test fails below 80%.

Power for a weaker relationship: a same-hour slope of 0.3% per pp with shared volatility, so much of the relationship rests on a few volatile hours. There are 200 data sets per sample size, and "median r" is the median sample correlation across them. The tests also fail if a median r falls outside 0.3–0.5 (0.3–0.55 for 10 sessions).

| Sessions | Median r | Detected (p < 0.05) | ± SE | 95% range | Test fails if |
| --- | --- | --- | --- | --- | --- |
| 10 | 0.47 | 29.0% (58) | 3.2 | 23.2–35.6% | 50% or more |
| 21 (about 30 days) | 0.42 | 48.5% (97) | 3.5 | 41.7–55.4% | 25% or less, or 75% or more |
| 62 (about 90 days) | 0.40 | 75.0% (150) | 3.1 | 68.6–80.5% | 55% or less |

A correlation around 0.4 is missed about half the time with 30 days of hourly data, so a non-significant result here is weak evidence of no relationship. That's why the Research section opens on 90 days of hourly data, where the same relationship was detected in 75.0% of data sets.

Market-adjusted results end to end (`lib/analytics/market-model.test.ts`): simulated research rows with a benchmark, 62 sessions (or trading days) loaded as in the page's 90 days, the market model fitted on all of them, and the tests run on the selected window as the page runs them. The stock moves 1.1× with its benchmark, with shared volatility; in most settings Kalshi also **tracks the benchmark** (the benchmark moves 0.1% per pp hourly, 0.3% daily), the case where β's uncertainty reaches the test. There's no link between Kalshi and the stock beyond the benchmark. On the same data sets: the primary test (β refitted), the same test with β treated as known (the previous method, for comparison), and the regression's bootstrap and Newey–West t. Each cell is the share with p < 0.05.

| Setting | Data sets | Primary, β refitted | β treated as known | Regression, bootstrap | Regression, Newey–West t |
| --- | --- | --- | --- | --- | --- |
| Hourly, 21-session window, Kalshi unrelated to the benchmark | 400 | 4.5% (18) ± 1.0, range 2.9–7.0% | 4.5% (18) | 4.5% (18) ± 1.0, range 2.9–7.0% | **8.0% (32)** ± 1.4, range 5.7–11.1% |
| Hourly, 21-session window (pooled across all runs) | 2,800 | 4.4% (124) ± 0.4, range 3.7–5.3% | 3.1% (88) | **6.4% (178)** ± 0.5, range 5.5–7.3% | **6.5% (181)** ± 0.5, range 5.6–7.4% |
| Hourly, 62-session window (90 days) | 300 | 4.7% (14) ± 1.2, range 2.8–7.7% | 1.7% (5) | 5.0% (15) ± 1.3, range 3.1–8.1% | 5.3% (16) ± 1.3, range 3.3–8.5% |
| Daily, 62-day window (pooled across all runs) | 1,300 | 4.8% (63) ± 0.6, range 3.8–6.2% | 2.5% (33) | 5.5% (71) ± 0.6, range 4.4–6.8% | **6.5% (85)** ± 0.7, range 5.3–8.0% |
| Daily, 20-day window | 300 | 2.3% (7) ± 0.9, range 1.1–4.7% | 2.3% (7) | 3.3% (10) ± 1.0, range 1.8–6.0% | 6.9% (10 of 144) ± 2.1, range 3.8–12.3% |

- **The primary test stays near 5% everywhere** (2.3% with 20 daily intervals, which have only about 10 runs of days), and it was within its bar in every setting on the first run: 4.5%, 5.3%, 4.7%, 6.3%, and 2.3% in the table's order. Treating β as known was conservative, most of all over 90 days (1.7% hourly, 2.5% daily).
- **The regression's bootstrap runs somewhat liberal with a 21-session window when Kalshi tracks the benchmark: 6.4% (178 of 2,800), with the whole 95% range (5.5–7.3%) above 5%.** That's within the test's 7.5% bar, but it isn't calibrated there; the Newey–West t is no better (6.5%). Where Kalshi is unrelated to the benchmark, the bootstrap is at 4.5% and Newey–West clearly too high (8.0%, the whole range above 5%). Over 62 trading days the bootstrap is 5.5%, within Monte Carlo error of 5%. There's no Newey–West p-value when Kalshi moved in fewer than 10 intervals, as in 156 of the 300 data sets in the 20-day daily setting.
- **Two rows are pooled across every run.** Their first runs (400 hourly and 300 daily data sets) put the regression's bootstrap at 8.0% (32 of 400) and 7.7% (23 of 300), above the test's bar. More data sets were then run to measure it more precisely: 1,000 hourly in development and 1,400 hourly and 1,000 daily for the suite. Reporting only the later runs would be selective, so the table and the committed tests pool all of them: 400 + 1,000 + 1,400 hourly and 300 + 1,000 daily. Rescaling the bootstrap residuals by leverage (an HC2-style transformation) lowered the hourly rate a little in development runs, but it would make the regression a different method from the correlations, so it isn't used.
- The tests fail if the primary test or the regression's bootstrap is below 2% or reaches 7.5% in an hourly setting, reaches 7.5% in a daily one, if Newey–West isn't above the bootstrap in the first setting, or if treating β as known isn't below refitting in the two settings where Kalshi tracks the benchmark hourly.

Intervals and detection, hourly, 62 sessions, shared volatility, a same-hour effect of 0.3% per pp (Kalshi unrelated to the benchmark): the primary test's interval covered the true slope in 96.0% (192 of 200) ± 1.4 (range 92.3–98.0%) of data sets, and the regression's in 95.5% (191 of 200) ± 1.5 (91.7–97.6%); each test fails outside 92–98.5%. A same-hour effect of 0.6% per pp with a 21-session window (Kalshi tracking the benchmark, independent volatility) was detected by the primary test in 98 of 100 data sets (the test fails below 80%).

Smallest detectable correlation (`lib/analytics/power.test.ts`): for each of 20 designs (Kalshi's path, the benchmark, the stock's volatility pattern; Kalshi tracks the benchmark, shared volatility), the detectable correlation is computed from one sample as the page does. Then 20 fresh samples of the same design, with new noise and that effect built in, each get the full primary test with its own 999-draw bootstrap. The target is 80%.

**Validation seeds, kept apart from development.** The method (averaging over the volatility's uncertainty, the 0.8 cap) was chosen by comparing alternatives on designs 52,000–55,019, so results on those seeds don't validate it. The table comes from a single run on designs that were never used in development: 80,000–80,019, 81,000–81,019, 82,000–82,019, and 83,000–83,019, with each design's fresh samples seeded 1,000,000 + 100 × design + j. The rule was set before the run: within 72–88%, keep the result. Outside that, keep the method unchanged on these seeds and show the measured rate on the page and here.

| Setting | Designs with a number | Median detectable r | Fresh samples detected | ± SE | 95% range |
| --- | --- | --- | --- | --- | --- |
| Hourly, 21 sessions (about 30 days) | 13 of 20 | 0.61 | 75.0% (195 of 260) | 2.7 | 69.4–79.9% |
| Hourly, 62 sessions (about 90 days) | 20 of 20 | 0.35 | 83.5% (334 of 400) | 1.9 | 79.5–86.8% |
| Daily, 62 trading days | 18 of 20 | 0.53 | 77.8% (280 of 360) | 2.2 | 73.2–81.8% |
| Daily, 20 trading days | 3 of 20 | 0.75 | **45.0% (27 of 60)** | 6.4 | 33.1–57.5% |

- **The three settings that usually get a number are within the 72–88% band, but not all on target.** With 21 hourly sessions it's optimistic: 75.0%, with the whole 95% range below 80%. Over 90 hourly days it's slightly conservative (83.5%), and over 62 trading days a little optimistic (77.8%).
- **With 20 daily intervals the few numbers it gives are unreliable: effects of the reported size were detected only 45.0% of the time (27 of 60), far below 80%.** 17 of 20 designs got no number at all. That's outside the band, so the method was left unchanged, and the page shows this rate whenever a 30-day daily window gets a number. **Improving it needs another set of fresh seeds**, since tuning on the validation seeds would make them development seeds.
- On the development seeds, the same method gave 76.2%, 76.8%, 80.3%, and 50% (20 of 40); those runs shaped the method and aren't the validation.
- The tests fail if a numbered setting falls outside 72–88%, if fewer than 15 of the 20-day designs get no number, or if the 20-day numbers reach 72% (the page would then overstate the problem). The detectable size varies from sample to sample of the same design, so it's a rough guide: the median shown is across designs.

Event study (62 sessions, shared volatility, jumps of at least 1.5 pp; 300 data sets, of which 263 had at least 5 rises to test):

| Result | No relationship | Drift of 0.4% per bar for 3 bars after rises | Test fails if (no relationship) |
| --- | --- | --- | --- |
| Bar +3, p < 0.05 | 2.7% (7) ± 1.0, range 1.3–5.4% | 40.7% (107) ± 3.0 | above 6% |
| Whole path, p < 0.05 | 5.3% (14) ± 1.4, range 3.2–8.7% | 26.2% (69) ± 2.7 | above 7.5% |
| 95% interval at bar +3 covers the true value | 94.3% (248) ± 1.4, range 90.8–96.5% | 95.4% (251) ± 1.3 | below 92% |

**The whole-path test is also slightly above 5% (5.3%)**, 0.2 standard errors away, so it's well within Monte Carlo error.

**Longer windows** (`lib/analytics/long-windows.sim.test.ts`, run with `pnpm test:sim`): the same simulated data and the same checks at 124, 252, and 372 sessions (or trading days), the market model fitted on the window itself as the page now does. Every seed was fresh (300,000 and up; designs 210,000–215,019 for the detectable size, their fresh samples 1,000,000 + 100 × design + j), and each setting ran once, with its bar and what to do outside it set beforehand.

False positives, Kalshi tracking the benchmark (0.1% per pp hourly, 0.3% daily), shared volatility, 400 data sets each:

| Setting | Primary, β refitted | β treated as known | Regression, bootstrap | Regression, Newey–West t |
| --- | --- | --- | --- | --- |
| Hourly, 124 sessions (180 days) | 4.0% (16) ± 1.0, range 2.5–6.4% | 1.0% (4) | 4.0% (16) ± 1.0, range 2.5–6.4% | 4.2% (17) |
| Hourly, 252 sessions (a year) | 4.5% (18) ± 1.0, range 2.9–7.0% | 1.0% (4) | 4.5% (18) ± 1.0, range 2.9–7.0% | 5.8% (23) |
| Hourly, 372 sessions (540 days) | 4.5% (18) ± 1.0, range 2.9–7.0% | 1.5% (6) | 4.5% (18) ± 1.0, range 2.9–7.0% | 5.2% (21) |
| Daily, 124 trading days | 4.8% (19) ± 1.1, range 3.1–7.3% | 2.0% (8) | 5.0% (20) ± 1.1, range 3.3–7.6% | 6.2% (25) |
| Daily, 252 trading days | **7.0% (28)** ± 1.3, range 4.9–9.9% | 3.2% (13) | **6.8% (27)** ± 1.3, range 4.7–9.6% | 6.0% (24) |
| Daily, 372 trading days | 4.0% (16) ± 1.0, range 2.5–6.4% | 1.2% (5) | 4.5% (18) ± 1.0, range 2.9–7.0% | 5.0% (20) |

Raw same-interval correlations with no link, 300 data sets each: 3.3% (10) ± 1.0 (range 1.8–6.0%) hourly with 252 sessions, 4.3% (13) ± 1.2 (2.5–7.3%) daily with 252 trading days. The tests fail at 7.5% (and, hourly, below 2% for the primary test and the regression).

Interval coverage, a same-interval effect of 0.3% per pp, Kalshi unrelated to the benchmark, 200 data sets each (the test fails outside 92–98.5%): hourly, 94.0% (188) ± 1.7 (range 89.8–96.5%) with 124 sessions, 93.0% (186) ± 1.8 (88.6–95.8%) with 252, and 94.5% (189) ± 1.6 (90.4–96.9%) with 372, the same counts for the primary test and the regression.

- **Daily data over a year runs a little liberal.** With 252 trading days the 95% intervals covered the true effect in only **90.0% (180 of 200) ± 2.1, range 85.1–93.4%** for the primary test and 89.5% (179) for the regression, below the 92% bar; the false-positive rate in that setting was 7.0%, within the 7.5% bar but above 5% (with 124 and 372 trading days it was 4.8% and 4.0%). As decided beforehand, the method is unchanged, the page shows these rates whenever a daily window is longer than 90 days, and that test's bar is loosened to 85% with this disclosure. Why isn't established; one untested possibility is the simulated volatility persisting longer than the bootstrap's runs of 4 trading days (see Limitations). The hourly settings don't show it.

Smallest detectable correlation at the longer windows, 20 designs × 20 fresh samples each, every design with a number (the test fails outside 72–88%):

| Setting | Median detectable r | Fresh samples detected | ± SE | 95% range |
| --- | --- | --- | --- | --- |
| Hourly, 124 sessions | 0.27 | 83.0% (332 of 400) | 1.9 | 79.0–86.4% |
| Hourly, 252 sessions | 0.18 | 80.0% (320 of 400) | 2.0 | 75.8–83.6% |
| Hourly, 372 sessions | 0.16 | 83.5% (334 of 400) | 1.9 | 79.5–86.8% |
| Daily, 124 trading days | 0.34 | 74.2% (297 of 400) | 2.2 | 69.7–78.3% |
| Daily, 252 trading days | 0.28 | 83.2% (333 of 400) | 1.9 | 79.3–86.6% |
| Daily, 372 trading days | 0.20 | 84.8% (339 of 400) | 1.8 | 80.9–87.9% |

On these simulated data, the detectable correlation falls from 0.35 at 62 hourly sessions (above) to 0.18 at a year, but that assumes Kalshi moves as much in older months as in recent ones; on the open Fed markets it doesn't (see [Longer windows](#longer-windows)).

Event study over a year (252 sessions, shared volatility, jumps of at least 1.5 pp, 300 data sets): bar +3 had p < 0.05 in 2.7% (8) ± 0.9 (range 1.4–5.2%), the whole path in 3.3% (10) ± 1.0 (1.8–6.0%), and the bar's 95% interval covered zero in 93.0% (279) ± 1.5 (89.5–95.4%). The test fails at 6% for the bar, 7.5% for the path, or below 92% coverage.

How often the fragile warning fires (`lib/analytics/fragility-rates.sim.test.ts`, run with `pnpm test:sim`): hourly, Kalshi tracking the benchmark, shared volatility, 200 data sets per row, leave-one-out with 199 draws. These report, not calibrate. F1 and F3 are the thresholds fixed before any of these runs; F2 is the check dropped from the warning on 2026-10-19 because of the F2 column below, still counted to show why. The warning is F1 or F3.

| Window | Effect | F1: < 10 effective moves | F3: a leave-one-out flips the decision | Warning (F1 or F3) | F2, dropped: < 8 effective sessions |
| --- | --- | --- | --- | --- | --- |
| 21 sessions (30 days) | none | 69.0% (138) | 13.0% (26) | **75.0% (150)** ± 3.1, range 68.6–80.5% | 99.0% (198) |
| 21 sessions (30 days) | 0.3% per pp | 62.0% (124) | 54.0% (108) | 81.5% (163) | 100% (200) |
| 62 sessions (90 days) | none | 10.5% (21) | 15.0% (30) | **22.5% (45)** ± 3.0, range 17.3–28.8% | 98.5% (197) |
| 62 sessions (90 days) | 0.3% per pp | 9.0% (18) | 29.0% (58) | 36.0% (72) | 94.5% (189) |
| 124 sessions (180 days) | none | 1.0% (2) | 12.0% (24) | **13.0% (26)** ± 2.4, range 9.0–18.4% | 85.5% (171) |
| 124 sessions (180 days) | 0.3% per pp | 0% (0) | 9.0% (18) | 9.0% (18) | 72.5% (145) |
| 252 sessions (a year) | none | 0% (0) | 11.5% (23) | **11.5% (23)** ± 2.3, range 7.8–16.7% | 61.0% (122) |
| 252 sessions (a year) | 0.3% per pp | 0% (0) | 2.0% (4) | 2.0% (4) | 43.0% (86) |

- **With no real relationship, the warning comes on by chance in 11.5–13.0% of data sets at 180 days and a year, 22.5% at 90 days, and 75.0% at 30 days**, where F1 dominates: 30 days hold too few Kalshi moves for the estimate to rest on many. F3 alone is 11.5–15.0% with no link, which includes p-values near 0.05 crossing it by Monte Carlo error. The page quotes these rates under the warning.
- **F2 fired in nearly every data set with no link (99.0% at 30 days, 98.5% at 90, 61.0% at a year), though the bootstrap stays calibrated there** (false positives 4.4–4.7% in the same design, above): most sessions have no Kalshi movement, so the score always sits in a few of them. That's why it was dropped from the warning; the same runs, with the same seeds, give every column here, and the warning's counts were recomputed on them after the change.

Not in the test suite: comparisons with the methods tried and dropped (the old ±1.96/√n band, shuffling Kalshi between sessions, a placebo-window event test, and plain percentile event intervals). Those ran during development: the tests over-rejected, mostly when volatility was shared, and the percentile intervals under-covered. They aren't reproducible from the repository, so no figures are given here. An independent Python reimplementation (numpy and statsmodels, refitting every bootstrap draw instead of using the closed form) reproduced the p-values, intervals, Holm and BH adjustments, effective n, and random-number stream exactly. That check predates refitting β in every draw; raw-returns results are unchanged since (pinned in `wild-bootstrap.test.ts`), and the new closed form is checked in the test suite against refitting draw by draw.

**Limitations.**

- The wild bootstrap treats sessions (hourly) or runs of 2–3 days (daily) as independent and residual signs as symmetric. Daily autocorrelation longer than a run isn't covered.
- β's uncertainty is carried into the primary test, the market-adjusted lead-lag chart, and the regression, but **the event study still treats its β as known** (fitted outside the jump windows). The rolling correlation is descriptive and has no test.
- The smallest detectable correlation is a rough guide: it comes from one sample's volatility, averaged over how uncertain that is. In validation it was somewhat optimistic with 21 hourly sessions (75%), and unreliable with 20 daily intervals (45%).
- Intervals on the correlation scale use the sample standard deviations, ignoring their own uncertainty.
- The sign-flip test assumes deviations from the baseline would be symmetric if jumps were unrelated to the stock; skewed returns weaken that. The baseline is treated as fixed.
- Holm is conservative because neighboring lags and bars share data; BH assumes they're positively dependent, which is plausible but not guaranteed.
- Corrections apply within each chart's family, not across the page or across the settings tried. A [scan](#scan) corrects across its candidates, but not across scans.
- Small samples can't show much: 30 days of daily data has about 10 runs of days, and most of its intervals span nearly everything.
- Daily data over a year runs a little liberal in simulation (intervals covering 90%, 7.0% false positives); the page says so for daily windows longer than 90 days.
- Longer windows assume β, and the link being tested, are the same throughout up to 540 days; a Fed market a year before its meeting is a different instrument from one a week before.
- The fragility diagnostics were added after the fed-history study's result (where one hour held 46% of ΔE's variation) and describe the data, not the hypothesis; the warning's thresholds were fixed before any of this branch's results, and one of the three (F2) was dropped on 2026-10-19 on simulated evidence alone. The warning comes on by chance in 11.5–75% of analyses with no relationship, depending on the window.

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

## Reports

**Report…** in Research's controls (and on a finished scan) exports what's on screen, to attach to an application or walk through: a **printable page** (a standalone HTML document opened in a new tab: print it, or save it as PDF from the browser's print dialog) or **Markdown** (`eventlens-report_NVDA_KXFEDDECISION-26OCT-H25_90d-hourly_2026-10-07.md`). It's built in the browser from the page's own results, so it costs no requests, and it needs no new dependencies (`lib/report`, `components/report`).

- **An analysis's report:** the plain-English summary (see [In plain English](#in-plain-english)); the question and the inputs (every setting, the window's dates, and whether it's frozen); data sources with fetch times and how far stored Kalshi history reaches; the methods in plain language (the primary test, the wild cluster bootstrap, Holm and Benjamini–Hochberg families, the market model and its sample, the detectable size, the fragility thresholds); the results (the primary test with its interval and p, the detectable size when it isn't significant, the fragility diagnostics and warning, the market adjustment and its cross-check, lead-lag, rolling correlation, and the event study, with charts); what a frozen link reproduces; the caveats and the disclaimer; the terms used; and the app's version and commit, the link, and the generation time.
- **A scan's report:** the same around the scan: its plain-English summary, how its candidates were chosen, each candidate's Kalshi source, the exploratory-leads banner, the ranked table with both corrections and F1/F3, and the candidates that couldn't be tested.
- **Options:** **Prepared by** (optional, remembered in this browser only), and **Include the reproducible link** (on by default; it opens behind this site's sign-in). The Inputs list every setting either way.
- **No stock prices.** Twelve Data's free plan doesn't allow showing its data outside the app, and a report attached to an application is outside it. So reports carry statistics (correlations, betas, p-values, counts) and Kalshi data, but no stock price, price series, or price chart. They also leave out each influential hour's abnormal return, and the event study's averages for rises or falls with fewer than 5 events (close to one event's return path): their counts and the page's warning stay. The charts (lead-lag intervals, the rolling correlation, and event-study paths for groups of at least 5) plot only those statistics. `components/report/licensing.test.tsx` builds every kind of report from a fake world whose stock and benchmark trade near 98,765 and 87,654, and fails if any bar's price appears in any form; a positive control proves the search finds one.
- **The numbers are the page's.** Reports use the page's own formatters and wording. `components/report/accuracy.test.tsx` renders the page as the server does and builds its report from the same inputs: every table they share matches cell for cell (less the columns left out), the primary result reads the same, and every number in the results is on the page, for a market, an event, and a self-benchmark; `scan-report.test.tsx` does the same for a scan. (The longer windows' results come from the same results object; the static render can't show them, so they aren't in that test.)
- **Version and commit** come from `package.json`'s version (bumped before each release is tagged) and `VERCEL_GIT_COMMIT_SHA`, or `git rev-parse HEAD` locally, set at build time by `next.config.ts`.

## In plain English

A card at the top of Research, and a summary at the top of a scan's results, say what the analysis found in short sentences and everyday words, for readers who don't read the statistics. They compute no new statistics: they read the page's own results (the primary test, the fragility diagnostics and leave-one-out check, the detectable size, the regression with the benchmark held fixed, and the corrected lead-lag results) and put them into words. They never give trading advice.

### The evidence rating

The one new piece of logic is a rating of how strong the evidence is: **Not enough data**, **No clear link**, **Weak**, **Moderate**, or **Strong** (`lib/analytics/evidence.ts`). These rules were fixed on 2026-10-27, written here before any simulation of them ran, and are not tuned to any result, simulated or real. They use only results the page already computes. The first rule that matches decides:

| # | When | Rating |
| --- | --- | --- |
| R1 | No primary test: no market-adjusted returns (the stock is its own benchmark, or the benchmark is missing or has too few prices) | No rating (the card says why) |
| R2 | The primary test has no p-value (fewer than 8 sessions or runs of days, too few pairs, no Kalshi movement, or unstable) | Not enough data |
| R3 | A result the rating needs is still computing: the leave-one-out check when p < 0.05, the detectable size when p ≥ 0.05 | Checking… (no rating yet) |
| R4 | p ≥ 0.05, and Kalshi's movement rests on fewer than 10 effective intervals (F1) | Not enough data |
| R5 | p ≥ 0.05, and the smallest detectable correlation is missing, above the ±0.8 cap, or above **±0.30** (as the page shows it, to two decimals) | Not enough data |
| R6 | p ≥ 0.05, in a window whose detectable size failed validation (its whole 95% range below the 80% it claims): 30D hourly (75.0%), 30D daily (45.0%), 180D daily (74.2%) | Not enough data |
| R7 | p ≥ 0.05 otherwise | No clear link |
| R8 | p < 0.05, and fragile: F1 or F3 (a leave-one-out rerun changes the decision) | Weak |
| R9 | p < 0.05 without a confidence interval | Weak |
| R10 | **p < 0.005**, not fragile, and not a daily window past 90 days (where the intervals covered 90.0% and false positives were 7.0% in validation) | Strong |
| R11 | p < 0.05 otherwise | Moderate |

- **±0.30** is Cohen's conventional "medium" correlation: "No clear link" says the test had a fair chance (80%) of finding a link of that size and didn't. In the committed simulations above, the median detectable size is 0.35 at 90 hourly days, 0.27 at 180, and 0.18 at a year, so at the default 90 days a result that isn't significant will usually read "Not enough data": 90 hourly days usually can't rule out a medium-sized link.
- **0.005** is the threshold Benjamin et al. (2018) proposed for strong evidence. With the page's 999 draws the smallest p is 0.001, so it can be reached.
- **A fragile result is never rated above Weak**, and a result that isn't significant with too few moves or too little power is "Not enough data", never "No clear link".
- **A check that couldn't run counts as tripped:** if the fragility diagnostics or the leave-one-out check couldn't be computed for a result with a p-value, it's treated as fragile (F1 or F3) and rated accordingly.
- **The calibration misses** in R6 and R10 are the validations in the tables above whose whole 95% range fell on the wrong side of the target. The card names the one that applies.
- **Strong evidence isn't a big effect.** When the rating is Moderate or Strong and |r| is below 0.10 (as shown, to two decimals), the card adds that the evidence is convincing but the link itself is small.

**A scan's strongest lead** (the top-ranked candidate that was tested) is rated on the scan's Benjamini–Hochberg-adjusted p, since it was picked from many. The scan computes no detectable size, so a lead that doesn't survive the correction isn't called "No clear link":

| When | Rating |
| --- | --- |
| Doesn't survive BH, with F1 | Not enough data |
| Doesn't survive BH, otherwise | **Nothing stood out** (its own page shows how large a link its data could detect) |
| Survives BH, and fragile (F1, or F3 from its leave-one-out check) | Weak |
| Survives BH, BH-adjusted p < 0.005, not fragile, and not a daily window past 90 days | Strong |
| Survives BH otherwise | Moderate |

With no relationship anywhere, a lead is rated Weak or above only when something survives BH, which the scan simulations (see [Scan](#scan)) put at 5.2%, 3.0%, and 4.0% of independent scans of 10, 30, and 100 candidates.

### Checking the rating by simulation

Set before any run (`lib/analytics/evidence-rates.sim.test.ts`, run with `pnpm test:sim`): each data set is rated exactly as the page rates it, with the primary test and leave-one-out check at 999 draws and the detectable size at 999 simulated samples and 200 resamples (leave-one-out only when p < 0.05 and the detectable size only when p ≥ 0.05, the only cases the rules use them).

- **Design:** hourly, Kalshi tracking the benchmark (0.1% per pp), shared volatility (the stress case of the fragility simulations above). Windows of 21, 62, and 124 sessions (30, 90, and 180 days); the market model is fitted on 62 loaded sessions for 30 and 90 days and on the window itself for 180, as the page does.
- **No relationship:** 500 data sets per window, seeds 7,000,000–7,000,499, 7,010,000–7,010,499, and 7,020,000–7,020,499.
- **Real effects:** a same-hour effect of 0.1% per pp (seeds 7,100,000, 7,110,000, 7,120,000 + 0–199) and 0.3% per pp (seeds 7,200,000, 7,210,000, 7,220,000 + 0–199), 200 data sets per window. All seeds are fresh.
- **The test fails, with no relationship, at any window, if** Moderate + Strong is above 6.0% (30 of 500), Strong is above 1.0% (5 of 500), or Weak + Moderate + Strong is above 7.5%.
- **With the 0.3% per pp effect, it fails if** "No clear link" is above 20% at any window: the label must not hide a link larger than its ±0.30 threshold.
- **Reported, without a bar:** every rating's share with no relationship and with both effects, the median sample correlation with each effect, and the run time.
- **Each setting runs once.** Rates are given with their count, one Monte Carlo standard error, and a 95% Wilson range. If a bar is missed, the rules stay as they are, the measured rate is shown on the page and here, and only that bar is loosened, with this disclosure. Daily data, a year, and All use the same rules but aren't simulated, and the card says so.

**Results** (the single run, 2026-10-27; 287 s on an Apple-silicon Mac). With no relationship, 500 data sets per window; each cell is the share of data sets with that rating, with the count in brackets:

| Window | Not enough data | No clear link | Weak | Moderate | Strong | Moderate + Strong (bar 6.0%) | Weak or above, i.e. p < 0.05 (bar 7.5%) |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 30 days | 93.8% (469) | 0% (0) | 5.6% (28) | 0.6% (3) | 0% (0), range 0–0.8% | 0.6% (3) ± 0.3, range 0.2–1.7% | 6.2% (31) ± 1.1, range 4.4–8.7% |
| 90 days | 67.6% (338) | 25.4% (127) | 3.8% (19) | 1.4% (7) | **1.8% (9) ± 0.6, range 0.9–3.4%** | 3.2% (16) ± 0.8, range 2.0–5.1% | 7.0% (35) ± 1.1, range 5.1–9.6% |
| 180 days | 25.6% (128) | 69.0% (345) | 1.8% (9) | 3.0% (15) | 0.6% (3) ± 0.3, range 0.2–1.7% | 3.6% (18) ± 0.8, range 2.3–5.6% | 5.4% (27) ± 1.0, range 3.7–7.7% |

- **One bar was missed: at 90 days, Strong came up in 1.8% of data sets with no relationship (9 of 500, range 0.9–3.4%), above the 1.0% bar** (5 of 500). The whole 95% range is above the 0.5% that a p-value below 0.005 should give, so in this design the primary test is somewhat liberal far out in its tail at 90 days. As decided beforehand, the rules are unchanged, the test's bar for that one setting is loosened to 2.0%, and the card says so whenever it rates a 90-day hourly result Strong. The other two windows passed (0 and 3 of 500).
- **The primary test's false-positive rate is in the last column** (every result with p < 0.05 is rated Weak or above): 6.2%, 7.0%, and 5.4%, within the 7.5% bar. At 90 days the whole range (5.1–9.6%) is above 5%, unlike the earlier 4.7% (14 of 300) in [Statistical tests](#statistical-tests); those runs used 199 draws and other seeds, and the two figures are 1.4 standard errors apart.
- **Moderate or Strong** came up in 0.6–3.6% of data sets with no relationship, all within the 6.0% bar: fragile results (Weak) take the rest of the chance rejections, most of all at 30 days, where few hours carry Kalshi's movement.
- **What a result that isn't significant says** depends on the window: at 30 days it's always "Not enough data" (R4–R6), at 90 days mostly so (67.6%), and at 180 days mostly "No clear link" (69.0%).

With real effects, 200 data sets per window (median sample correlation in brackets):

| Effect | Window | Not enough data | No clear link | Weak | Moderate | Strong |
| --- | --- | --- | --- | --- | --- | --- |
| 0.1% per pp | 30 days (r 0.12) | 85.5% (171) | 0% (0) | 11.5% (23) | 2.5% (5) | 0.5% (1) |
| 0.1% per pp | 90 days (r 0.13) | 56.0% (112) | 19.5% (39) | 9.5% (19) | 8.0% (16) | 7.0% (14) |
| 0.1% per pp | 180 days (r 0.12) | 18.0% (36) | 49.0% (98) | 11.0% (22) | 12.5% (25) | 9.5% (19) |
| 0.3% per pp | 30 days (r 0.36) | 57.5% (115) | 0% (0), range 0–1.9% | 33.5% (67) | 4.0% (8) | 5.0% (10) |
| 0.3% per pp | 90 days (r 0.35) | 17.0% (34) | 0.5% (1), range 0.1–2.8% | 17.0% (34) | 11.5% (23) | 54.0% (108) |
| 0.3% per pp | 180 days (r 0.33) | 4.5% (9) | 3.0% (6) ± 1.2, range 1.4–6.4% | 3.5% (7) | 12.0% (24) | 77.0% (154) |

- **"No clear link" didn't hide the larger link** (correlations around 0.33–0.36, above its ±0.30 threshold): 0–3.0% of data sets, within the 20% bar.
- **It does miss small links, as its wording says.** With a real correlation around 0.12, well under the ±0.30 the label is set at, the card said "No clear link" in 19.5% of data sets at 90 days and 49.0% at 180. That's why it says a strong link is unlikely but a weaker one can't be ruled out.
- **Strong evidence isn't a big effect:** with a real correlation around 0.12, 7.0–9.5% of data sets were rated Strong at 90 and 180 days: strong evidence of a modest link. The headline's size word and the effect in percent say how big it is, and below |r| = 0.10 the card adds that the link itself is small.

### What the card says

The card sits above the Research card, for a single market and for a whole event (`components/plain/`). In order:

- **A headline** in one sentence: which way the stock tended to move when Kalshi's probability (or the expected rate change) rose, by how much ("slightly" below |r| = 0.10, "somewhat" up to 0.30, "clearly" from there), beyond what moves in the benchmark explain. A Weak rating starts "A weak sign"; the others say there's no clear link, or not enough data to tell.
- **How strong is the evidence?** The rating on a three-step meter (Weak, Moderate, Strong; No clear link fills none, and Not enough data is hatched), always written out in words, then the reason and the main test's r, 95% range, and p-value as the page prints them. While the leave-one-out check or the detectable size that the rating needs is still computing, it says "Checking…".
- **How big is it?** The regression's Kalshi coefficient with the benchmark held fixed, for a 10-percentage-point rise in a market's probability or a 25-basis-point rise in an event's expected rate change, with its likely range. It says when the range includes zero, and when the size points the other way from the main test.
- **Does Kalshi move first?** From the corrected lead-lag results: a lag counts when its Benjamini–Hochberg p is under 0.05. It always adds that moving together in the same hour isn't predicting.
- **How much to trust it:** the fragility result, and how often its warning comes on by chance at this window; the sample (intervals, Kalshi moves, trading days); a short window or few moves; where Kalshi's history came from; whether the numbers are live or frozen; and any calibration note that applies (Strong at 90 days hourly, daily data over long windows, and settings that weren't simulated).
- **What this can't tell you:** one fixed sentence: it isn't a prediction, it doesn't show cause and effect, and it isn't a recommendation to buy or sell anything.

Folded away under it are **How the rating works** (the rules and the simulation results, in words) and **What the terms mean** (the glossary).

**The scan's summary** opens a scan's results. It says how many candidates still looked related after correcting for testing many at once, how many had p under 0.05 before correcting against how many chance alone would give (5% of those tested), and what the strongest lead is, rated by the scan lead rules above. While the scan runs it says "so far", the lead's rating waits for the leave-one-out check, and it always adds that leads at the top of a scan are probably overstated.

**In reports,** an analysis's or a scan's report opens with **In plain English** (the card's text part by part, its level as "Evidence: Strong", and, for an analysis, how the rating works) and ends with **Terms used** (the glossary), before the footer.

### Terms

Twelve terms have definitions of one or two sentences (`components/plain/glossary.ts`): correlation, p-value, confidence interval, market-adjusted, beta, percentage points, basis points, bootstrap, Holm and Benjamini–Hochberg, fragile, lead-lag, and expected rate change. The first use of each in the card is marked with a dotted underline, as are a few places on the rest of the page where the term is plain text: beta, market-adjusted, the primary test's p-value, the fragile flag and the bootstrap, the lead-lag card's title and Holm, and correlation. The event panel's and the scan banner's wording is built in code, so it isn't marked; the card marks "expected rate change" itself. A marker is a few words at most, since a browser never breaks a button across lines.

- **Hover or focus** shows the definition; **a tap or click** keeps it open; **Escape, a tap elsewhere, or moving focus away** closes it. The open and close rules are a pure reducer (`components/plain/Term.tsx`), tested without a browser.
- **The definition is in a live region,** so a screen reader announces it when it opens, and the marked term is a real button, reachable with Tab.
- **The popover stays inside the viewport,** so nothing scrolls sideways, down to 320 px.

### How it's checked

- **The numbers are the page's.** `components/plain/accuracy.test.tsx` renders 14 analysis pages from the fake world: markets and events, at the default 90 days hourly and other settings, at 7 days, and with a stock that is its own benchmark. The card must be the summary built from the same rows and settings, and every number in it must be printed elsewhere on the page. The only exceptions are declared, and each is checked against its source: a size rescaled to 10 pp or 25 bp (consistent with the page's per-unit figure), a lag's count of hours, and the rating's own thresholds and simulation figures. The fake world's stocks don't move with Kalshi, so test symbols whose price follows one market (`linkSymbol` in `lib/history/test-world.ts`) reach Strong, Moderate, Weak, and the lead-lag sentences on the real page. `scan-accuracy.test.tsx` does the same for 5 scans, reaching Not enough data, Nothing stood out, Weak, and Strong. Both check that the report's sections say what the card says. 180D, 1Y, and All can't be rendered statically (their rows load in an effect), so `summary.test.ts` summarizes a 180-day window's own results (124 sessions, computed as the panel computes them), and the wording tests cover the 1Y and All settings.
- **No trading language, and short sentences.** `components/plain/language.test.ts` runs every wording path: each rating rule for a market and an event at six settings, a scan in every state, the glossary, how the rating works, and the report sections. None may use "buy", "sell", "signal", "opportunity", "recommend", "profit", or "should invest", in any form, except the one fixed sentence that says this isn't a recommendation to buy or sell, which must appear exactly once. No sentence may run over 25 words, and each card must be at a Flesch–Kincaid grade of 9 or lower (numbers, tickers, and Kalshi's labels count as one plain word).
- **The rest of the page is unchanged.** The card sits in its own `<section data-plain-english>` in the Research card's place among the panel's children, so React's ids for the cards below don't move. The page pins (`components/research/page-pins.test.tsx`) leave the card out and read a closed term marker back as its text, and every pin passes unchanged.

## Event analysis

A single outcome market of a multi-outcome event has an ambiguous sign: a rising "no change" probability is dovish when the alternative is a hike and hawkish when it's a cut. For Fed decision events (`KXFEDDECISION-26OCT`, and the legacy `FEDDECISION-…` ones), EventLens analyzes the whole event as one number, the **expected rate change** E = Σ pᵢ·vᵢ / Σ pᵢ over the outcomes open at the time, in basis points. The method is an exact port of the fed-history study's (`lib/expected/engine.ts`); `scripts/check-expected-value.ts` checks it against the study's marks (all 2,049 marks of its 27 meetings agree).

- **Values v** come from each outcome's contract text: its structured strike (`custom_strike`) and YES label must agree, and its title and rules mustn't contradict them (KXFEDDECISION-25JAN-H0 has no structured strike, so its label, title, and rules must all agree). A cut is negative; "more than X" counts as the next 25 bp step. Ticker suffixes never decide a value. If any outcome can't be mapped, two map to the same value, or Kalshi doesn't mark the outcomes mutually exclusive, the event has no E, and the page says which outcome and why.
- **Probabilities p** come from each hour's closing book: the bid/ask midpoint, half the ask without a bid, or halfway from the bid to $1 without an ask (a bid of 0 or an ask of $1 is no quote). An outcome with no usable quote in the last 7 days counts as 0 if it was last at most 5¢.
- **E is missing**, never carried over, when Σp is outside 0.80–1.20, when an outcome's quote is stale, when the collected history has a gap, and from the first outcome's close on.
- **The page** shows E now (from the live books), its 1h and 24h change, each outcome's value, probability, and weight, E over 90 days, and the outcome probabilities behind it. Research is the same as for one market, with ΔE in bp as the Kalshi variable: an interval whose open outcomes changed is left out, and the event study's jump sizes are 0.25–5 bp (0.5 bp hourly and 2 bp daily by default). For a closed event, Research ends at its first close. The CSV has the same columns with `kalshi_expected_bp` and `expected_change_bp` in place of the probability columns, `expected_missing:<reason>` in `kalshi_exclusion`, and `sum_p` and `open_outcomes` appended.
- **Requests:** the event (`/events/{ticker}`), each outcome's 97 days of hourly candles from the store first (batched live requests, or Kalshi's archive, for the rest), the same for the longer windows from a week before the first outcome opened, and the same 3 or 5 Twelve Data credits as one market.

## Scan

**Scan** (`/scan`, linked from the header) tests one stock against many Kalshi candidates at once and ranks the results, corrected for testing them all. It's for finding **leads**, and the page says so: a ranked list of exploratory results, each linked to its full single analysis, never a finding on its own.

**Candidates.** Pick the stock, then one of:

- **a series' open events** (e.g. `KXFEDDECISION`), optionally with its stored settled events;
- **every stored event**, settled ones included (from the data store);
- **a custom list**: tickers pasted, or added from search; events or markets, settled ones too.

There's **one test per event**, since the outcomes of one event are near-duplicates. A Fed decision event is tested on its expected value E(t), and an event with a single market on that market.

Any other event with several outcomes is tested on one of them:

- **While the event is open:** its open outcome with the highest lifetime volume. An open outcome is one listed as trading whose close hasn't passed.
- **Once every outcome has closed:** its outcome with the highest lifetime volume.

The outcome is picked from the listing before any stock data loads, and the page names it ("most-traded of 2 open (5 in all)"). A custom list can still name specific outcome markets; the page then groups them and says they're correlated. A scan holds at most 200 candidates.

Changed on 2026-10-22: picking among every outcome could test an open event on an outcome that had already closed. In the live check, an NVIDIA release-date event was tested on its "before Oct 2026" outcome, closed on Sep 30.

**The test.** Each candidate gets exactly the primary test its own page runs:

- the same-interval correlation of the Kalshi change with the stock's market-adjusted return (against SPY);
- at the chosen window (7D to All) and resolution;
- with the market model refitted in every one of 999 wild bootstrap draws.

Its r, interval, and p therefore match its page. `lib/scan/parity.test.ts` checks this through the loaders for a live and a settled market and a live and a settled event at eight window and resolution choices. Each candidate's window ends where its page's does: at its close if it has closed, otherwise now.

There are two differences, both by design:

- **No quote.** The scan doesn't spend a credit on the quote, so today's session counts as complete at its scheduled 4 PM close. On an early-close day, between the early close and 4 PM, the page already counts today's bar and the scan doesn't.
- **Splits.** A split inside the scan's span can rescale 30-minute bars over more split sessions than one page sees.

**Finer p-values.** With 999 draws the smallest p is 0.001, and Holm needs p < 0.05/m, so in a scan of 50 or more nothing could ever pass. So:

- A candidate whose p is under 0.10 gets a fresh p from **19,999 draws** of its own random stream, and the corrections use that p.
- The smallest possible p is then 1/20,000, a tenth of 0.05/m at m = 100.
- The combination is a valid p-value without any independence between the stages. For u below 0.10, p ≤ u needs the fresh p ≤ u; at or above 0.10, it needs the first p ≤ u. Each of those has probability at most u.

**Corrections and ranking.**

- Holm and Benjamini–Hochberg run over every candidate that could be tested.
- Candidates that couldn't be tested (too few sessions, no overlap, failed to load) are listed with their reason and left out of m, since why they couldn't be tested doesn't depend on the stock.
- Results are ranked by adjusted p. Ties go to the first p, then the ticker, never the effect's size.
- While a scan runs, candidates still to come count as p = 1. That makes every adjusted p shown an upper bound on its final value, so a result marked as surviving never stops surviving.

**Honesty on the page.** Above the results, always:

- "Exploratory leads, not findings."
- How many first-stage p-values are under 0.05, against the 5% of candidates chance alone would give.
- The survivor counts, and what Holm and BH each promise.
- The winner's curse: the top-ranked effects are likely overstated. The median |r| across the scan is shown as a baseline.
- Which series and events hold several candidates, whose results are correlated.
- That the corrections cover this scan only, not lists chosen after seeing results or several scans with the best kept.

Each row shows:

- r, its interval, and p as on the candidate's page, then the scan's p, Holm, BH, and which corrections it survives;
- **F1**, the effective number of Kalshi moves (fragile under 10), for every result;
- **F3**, leave-one-out over the 10 most influential sessions, as on the page, for the top 5 and any other survivor (at most 10), once every candidate is in;
- a link to the full analysis at the same window and resolution (`/?stock=…&kalshi=…&window=…&res=…`; without these, a page opens at 90D hourly as always).

**Cost.** The stock's and SPY's bars are fetched once for the whole scan. Per symbol, that's one 30-minute request per 540 days the candidates' windows span, plus one daily request. There's no quote.

| Scan | Twelve Data credits |
| --- | --- |
| Windows within 540 days (every open-event scan, at any window) | **4** (a single analysis: 5); SPY free when the server has it in memory |
| Spanning 541–1,080 days | 6 |
| Spanning 1,081–1,620 days (every stored Fed event, back to 2023, at 90D) | 8 |
| More | refused (the free plan allows 8 requests a minute); the page asks for a shorter list or window |

The page shows the cost before a scan runs.

The free plan's 8 requests a minute are shared by every user of the key, and Twelve Data counts requests it turns away against the minute too. So when the minute's requests are used up, the prices route answers with the time the next minute starts, and the page waits until then (at most twice) instead of retrying. Bars already fetched aren't requested again.

Kalshi data comes from the store first and live otherwise, 3 candidates at a time, retried after 2 s and 5 s when Kalshi is busy. The prices count as one analysis against the visitor's limit.

**Validation.** `lib/analytics/scan-*.sim.test.ts` (run with `pnpm test:sim`) simulates scans in which no candidate is related to the stock, and counts how often a scan shows any surviving result anyway. The settings and pass bars were fixed before the first run, and each setting ran once on fresh seeds (5,000,000–5,600,199).

The simulated scans:

- One stock and K candidates share the same 62 hourly sessions (the default 90D window and market-model sample).
- Each scan is computed as the page computes it: 999 draws, then 19,999 for a first p under 0.10, then Holm and BH at 5%.
- **Independent** candidates share only news days.
- **Correlated** candidates come in groups of five, like the meetings of one series: about 0.9 correlated within a group and 0.3 across.
- In the correlated setting, the shared part also moves the benchmark and the stock's volatility.

Each figure has its count in brackets, ± one Monte Carlo standard error, and a 95% Wilson range.

| Candidates | Scans | Survives Holm | Survives BH | Any p < 0.05, uncorrected | Test fails if |
| --- | --- | --- | --- | --- | --- |
| 10 independent | 400 | 5.2% (21) ± 1.1, 3.5–7.9% | 5.2% (21) ± 1.1, 3.5–7.9% | 43.0% (172) | Holm or BH ≥ 7.5% or < 2% |
| 30 independent | 400 | 3.0% (12) ± 0.9, 1.7–5.2% | 3.0% (12) ± 0.9, 1.7–5.2% | 72.8% (291) | Holm or BH ≥ 7.5% or < 2% |
| 100 independent | 300 | 3.3% (10) ± 1.0, 1.8–6.0% | 4.0% (12) ± 1.1, 2.3–6.9% | 98.7% (296) | Holm or BH ≥ 7.5% or < 2% |
| 10 correlated | 400 | 1.2% (5) ± 0.6, 0.5–2.9% | 2.8% (11) ± 0.8, 1.5–4.9% | 19.2% (77) | Holm or BH ≥ 7.5% |
| 30 correlated | 400 | 2.0% (8) ± 0.7, 1.0–3.9% | 2.5% (10) ± 0.8, 1.4–4.5% | 32.5% (130) | Holm or BH ≥ 7.5% |
| 100 correlated | 300 | 1.0% (3) ± 0.6, 0.3–2.9% | 2.3% (7) ± 0.9, 1.1–4.7% | 63.0% (189) | Holm or BH ≥ 7.5% |

- **Every setting passed.** With independent candidates, both corrections keep false leads near 5% (3.0–5.2%). With correlated ones they are conservative (1.0–2.8%), as Holm and BH are under positive dependence. That's why the correlated settings have no lower bar.
- **Read one by one, a scan almost always shows something by chance.** Without correction, scans with at least one p under 0.05 run to 43%, 73%, and 99% for 10, 30, and 100 independent candidates.
- **Each candidate's own test stays calibrated in these designs.** Its first p was under 0.05 for 4.6% of all candidates (4,253 of 92,000), and 4.1–5.6% per setting. The highest was 10 independent: 5.6% (223 of 4,000). The test fails at 7.5%.
  - No standard error or range is given for these rates. The usual ones (about ± 0.4 for 223 of 4,000) treat every candidate as independent. They aren't: candidates in a scan share the stock, and correlated ones also move together. So those ranges would understate the uncertainty.
  - The scan-level rates in the table don't have this problem: each scan counts once.
- **The price of scanning (descriptive, no bar).** One candidate of 30 moves the stock, by 0.3% per pp in the same hour; 200 scans.
  - Its own page finds it (p < 0.05) in 99.0% (198).
  - The scan ranks it first in 98.5% (197). It survives Holm and BH in 95.5% (191) ± 1.5, range 91.7–97.6%.
  - An unrelated candidate survives alongside it in 4.0% (8) of scans by Holm and 7.5% (15) by BH. BH bounds the expected share of false leads, not the chance of any.
  - This effect is clear in 62 sessions, so the price is small here. Weaker effects lose more.
- **Disclosed: how the figures were read.** The first run's bars all passed, but Vitest's reporter hid the figures logged by passing tests. The same seeds were run again to read them; that's the same data sets, not new ones.
- **Disclosed: a shortcut in the simulations only.** The simulations stop a finer p once it is sure to end above R·α/m (R = candidates refined), which can't change either correction's decision. The proof is in `scan-sim.ts`, and `scan-sim.test.ts` checks it against every draw. The page always computes every draw.
- **Not simulated:** daily resolution and the longer windows in a scan. Each candidate's test there is the single analysis's, validated in its own tables above, and the corrections don't depend on the window.

**Speed.** Compute (`scripts/bench-scan.ts`; Node on an Apple-silicon Mac, one run each, simulated candidates):

| Setting | 10 candidates | 30 | 100 | Longest step | Leave-one-out, top 5 |
| --- | --- | --- | --- | --- | --- |
| 90D hourly | 0.4 s | 1.1 s | 4.5 s | 19–35 ms | 0.8 s (steps ≤ 16 ms) |
| 30D hourly | 0.4 s | 0.8 s | 3.2 s | 12 ms | 0.5 s |
| 1Y hourly | 1.6 s | 3.0 s | 12.0 s | 77–79 ms | 3.3 s (steps ≤ 63 ms) |
| 90D daily | 0.08 s | 0.13 s | 0.6 s | 3 ms | 0.13 s |

Live, on the production build in headless Chrome (2026-10-22), with TLT, the data store, and the live APIs:

| Scan | Candidates | Twelve Data requests | First result | All done | Longest slice | Tasks over 50 ms |
| --- | --- | --- | --- | --- | --- | --- |
| Open Fed events, 90D hourly | 11 (all tested) | 4 expected (output of the first run lost), 0 on a rerun | 1.3 s | 4.7 s | 44 ms | 0 |
| Every stored Fed event, 90D hourly, back to 2023 | 40 (39 tested) | 8 | 1.8 s | 7.1 s | 44 ms | 0 |
| 100 open Economics and Financials events, 90D daily | 100 (37 tested) | 4 | 1.1 s | 31.4 s | 32 ms | 0 |

- **Kalshi dominates the time.** Loads averaged 0.5 s per stored candidate and 0.8–1.0 s per live one; one took 8.2 s.
- **The 100-event runs predate the change to picking.** Both ran on 2026-10-22 under the earlier rule (highest volume among every outcome), so a few open events were tested on outcomes that had already closed.
- **Many short-lived markets can't be tested.** The 100 events were chosen by a rule fixed before any result: open, in those two categories, earliest close first. Their reasons, on a rerun that listed 95: too few intervals with both prices (31), no Kalshi history in the window (21), no overlap (3), fewer than 8 sessions (2), unstable (1).
- **Listing a custom list of 100 tickers took 14 s.** Each ticker is looked up on Kalshi.

### Scan links and frozen scans

`/scan?…` carries the whole form (`stock`, `source` = `series`, `stored`, or `tickers`; `series`; `settled=1`; `tickers`; `window`; `res`; `asof`), prefilled when the link opens; nothing runs until **Run scan**, since a scan spends credits. The address bar follows the form. An optional **As of** freezes a scan: each candidate still open then ends there, and one that had closed by then at its close, as on its frozen page (`lib/scan/asof.test.ts` checks both, through the loaders and the runner). A finished scan offers its **frozen link**: its candidates as a custom list (an event's stand-in outcome as its own market) and its as-of time (its own, or when its prices were fetched), so it tests the same candidates later; a series or stored-events list made later can differ, as events open and close. One known edge: a candidate that closed in the 5 minutes before the as-of time would have its last benchmark close left out, which its own page keeps.

## Data store

An optional Postgres database (Neon, free plan) keeps Kalshi's history, so Research can study markets that settled before Kalshi's archive cutoff and end a closed market's windows at its close. It's off unless `DATABASE_URL` is set: without it, every request is live, exactly as before. Setup, roles, the watchlist, and the collector's details are in [`db/README.md`](db/README.md).

**The collector.** A GitHub Actions workflow (`.github/workflows/collect-kalshi.yml`) stores the hourly and daily candles of every market on the watchlist (to start, every KXFEDDECISION market) every 6 hours, from Kalshi's live endpoints and its archive. It also runs on demand, in any mode, or locally:

```bash
pnpm collect:kalshi                   # incremental: new candles, new markets' history, and up to 25 gaps
pnpm collect:kalshi --mode backfill   # every market's whole history again
pnpm collect:kalshi --mode repair     # every gap
pnpm db:migrate                       # create or update the roles and tables
pnpm db:watchlist list --all          # what the collector fetches (also add, remove, activate, deactivate)
```

Each window of candles is stored with the time range it covers, in one transaction, so a window that fails leaves a gap that the next run repairs. Stock collection is on hold until Twelve Data confirms its terms allow storing its data.

**What the app reads.** With `DATABASE_URL` set:

- Research's Kalshi history comes from stored candles first, with a live request for anything after them. If the store doesn't cover the window, or a read fails or takes longer than 2.5 seconds, it's fetched live as before. The Sources note says how far stored history reaches.
- A market that settled before Kalshi's archive cutoff (the live API answers 404 for it) opens from its stored row or from Kalshi's archive.
- For a closed market, Research's windows end at its close instead of now, the stock's bars and the benchmark cover them, and the Research card says so. An analysis still uses 3 or 5 Twelve Data requests.

## Project structure

```
app/                  Next.js routes (page.tsx renders the dashboard server-side)
  login/              Sign-in page, and the sign-in and sign-out actions
  api/search/         Search API routes: stocks/ and kalshi/ (GET ?q=…)
  api/benchmark/      Research benchmark prices (GET ?symbol=…, and &end=… for a window ending in the past)
  scan/               The scan page; api/scan/ lists candidates, loads a scan's prices once, and each candidate's Kalshi side
  studies/            This browser's saved studies
components/           UI components (cards, form, panels)
  auth/               Sign-in form and Sign out button
  analysis/           Loading analyses, shareable links (every setting, and the as-of time), Copy link, recent analyses
  studies/            Saved studies (this browser's localStorage), with export and import
  report/             An analysis's or a scan's report, built from what its page shows, and the Report and Prepared-by controls
  charts/             Recharts client components
  event/              A whole event's dashboard: its panel, E over time, outcome probabilities, Research with ΔE
  research/           Research panel (window, resolution, raw or market-adjusted returns, benchmark, analyses, CSV download)
  plain/              The plain-English card and the scan's summary, their wording, the glossary, and term markers
  search/             Stock and Kalshi search fields (comboboxes)
  scan/               The scan page and its runner (results as they finish, computed in slices)
lib/
  auth/               Access gate: sessions, password check, page and API route guards
  kalshi/             Kalshi API client, market search index, normalized types (server-only)
  market-data/        Twelve Data client, symbol lists and search, popular symbols, research benchmarks (server-only)
  history/            Research's data: stored history first, live for the rest; windows that end at a close
  expected/           Whole events: supported series, outcome values, the E(t) engine, and its read path
  store/              Data store: connections per role, migrations, runs and coverage, the watchlist
  collect/kalshi/     Kalshi collector: market discovery, candle windows, coverage, gap repair
  scan/               A scan's candidates (one per event), prices over its span, and each candidate's rows as its page builds them
  report/             Reports as plain data, their Markdown and printable HTML, SVG charts, and the build's version and commit
  analytics/          Pure metric, alignment, research, regression, and significance-test functions (and the CSV export)
  search/             Search contract: result types, query validation, error responses
  validation.ts       Ticker input validation
  format.ts           Number and date formatting
db/                   Data store migrations and setup (db/README.md)
scripts/              collect-kalshi, migrate, and watchlist (pnpm collect:kalshi, db:migrate, db:watchlist); check-expected-value; bench-research and bench-scan
proxy.ts              Sends requests without a session to /login (API routes get a 401)
```

Third-party API calls live in `lib/kalshi` and `lib/market-data`, run only on the server (enforced with `server-only`), and return normalized TypeScript types. The UI never calls third-party APIs directly: the search fields call this app's `/api/search/…` routes, and picking a benchmark calls `/api/benchmark`.

## Access

EventLens shows Twelve Data's data, and the free Twelve Data plan doesn't allow displaying it publicly, so every page and API route requires a signed-in session.

- **Signing in.** Anyone who isn't signed in is sent to `/login` and asked for the access password (`ACCESS_PASSWORD`). After signing in they land on the page they asked for, so a shared analysis link still opens that analysis. A sign-in lasts 30 days in that browser; **Sign out** (top right) ends it sooner.
- **Giving and removing access.** Share the password with the people you want to let in. To remove someone, change `ACCESS_PASSWORD` in Vercel and redeploy: that signs everyone out, and you give the new password to the people who should keep access. Changing `AUTH_SECRET` also signs everyone out, without changing the password. **Sign out** only ends the session in that browser.
- **What's protected.** `proxy.ts` (Next.js 16's name for middleware) runs on every request except build assets (`/_next/static/…` and `/favicon.ico`). Pages redirect to `/login`, and `/api/…` routes answer `401` with `{"error":{"code":"unauthorized",…}}`. The dashboard page and each API route also check the session themselves, so a gap in the proxy doesn't expose data. The CSV export and the reports are built in the browser from data that's already on the page, so they need no separate check; a report's link opens behind the same sign-in. The proxy covers new pages and routes automatically; give them their own check too, with `requirePageSession()` (pages) or `rejectUnlessSignedIn(request.cookies)` (API routes) from `lib/auth/`.
- **The session cookie.** `__Host-eventlens-session`: HttpOnly, Secure, SameSite=Lax, Path=/, 30 days. It holds only an expiry and an HMAC-SHA256 signature. The signing key is derived from both `AUTH_SECRET` and `ACCESS_PASSWORD`, so the cookie can't be used to guess the password, and the password check takes the same time however much of a guess is right.
- **Sign-in attempts.** Each IP can try 5 times a minute and 20 times an hour. Like the other limits, this is per server instance (see [Security](#security)), so it slows guessing rather than capping it. Use a long password (four or more random words, or `openssl rand -base64 18`), and add the Vercel Firewall rule in [Deploying to Vercel](#deploying-to-vercel) for a limit shared by all instances.
- **Missing settings lock the site.** Outside `pnpm dev`, if `ACCESS_PASSWORD` (12 to 256 characters) or `AUTH_SECRET` (at least 32 characters) is missing or the wrong length, nobody can sign in: every page redirects to `/login`, which says sign-in isn't set up, and the server log names the setting to fix.
- **Locally.** `pnpm dev` without `ACCESS_PASSWORD` skips sign-in entirely, and the server log says so once. With both settings in `.env.local` it asks for the password like the deployed site; the cookie is then called `eventlens-session` and isn't Secure, because the dev server uses plain http.
- **Link previews.** Apps that preview a shared link see the sign-in page, so the preview says "Sign in · EventLens" rather than naming the analysis.

## Security

- Every page and API route requires a signed-in session: see [Access](#access). `ACCESS_PASSWORD` and `AUTH_SECRET` are read only on the server.
- `TWELVE_DATA_API_KEY` is read only in server-only code and sent to Twelve Data in an `Authorization` header, never in a URL, so it stays out of browser code, cached request URLs, and logs.
- Ticker inputs are validated on the server before any upstream request. Search queries are validated too (at most 100 characters, no control characters) and never reach an upstream API.
- Users see fixed error messages. Twelve Data's own error text is logged on the server only, with the key redacted.
- Each client IP can run 5 analyses a minute and 30 an hour (`lib/analysis-rate-limit.ts`), pick 5 benchmarks a minute and 30 an hour (`app/api/benchmark/route.ts`), and run 30 searches a minute and 300 an hour in each search field (`app/api/search/*/route.ts`).
- Every upstream request times out after 6 seconds (the daily stock-list download after 45), and the Kalshi and stock sections load independently, so one slow API never hides the other's data.
- The data store's connection strings are read only on the server, from environment variables, and never logged. The app's role can only read; the collector's can add and update data but not delete it. The collector's GitHub Actions logs are public, so it prints counts and tickers only. See [`db/README.md`](db/README.md).

**How much the rate limit protects you.** The limiter keeps its counts in the server's memory. That is enough to stop one person repeatedly hammering the site, but it is not a hard guarantee:

- On Vercel, each server instance keeps its own counts, and counts reset when an instance restarts. A quiet site usually runs on one warm instance, so the limit mostly holds; under heavier traffic Vercel starts more instances and each one allows its own 5 per minute.
- Limits are per IP. People behind the same IP (an office, a mobile carrier) share one limit, and someone using many IPs can get around it.
- It does not cap total usage across all visitors, so it cannot stop the site as a whole from using up the Twelve Data plan.

For a hard limit, use a shared store such as Upstash Redis (`@upstash/ratelimit`) or a rate-limiting rule in the Vercel Firewall.

## Deploying to Vercel

1. Import the GitHub repository in Vercel.
2. Under **Project → Settings → Environment Variables**, add:
   - `ACCESS_PASSWORD`: the access password, 12 to 256 characters. A long passphrase is best.
   - `AUTH_SECRET`: at least 32 random characters, e.g. the output of `openssl rand -base64 32`. Don't reuse it anywhere else.
   - `TWELVE_DATA_API_KEY` (Production, plus Preview if you want preview deployments to show stock data). The key is only read at request time, so the build does not need it. If it is missing, the site still works and shows that stock data isn't set up; the server log explains how to fix it.
   - `DATABASE_URL` (optional, Production only, marked **Sensitive**): the data store's read-only connection string (see [`db/README.md`](db/README.md)). Without it, everything is fetched live. The build doesn't need it.

   Add `ACCESS_PASSWORD` and `AUTH_SECRET` to both **Production and Preview** and mark them **Sensitive**. Without them a deployment locks: nobody can sign in. Changes to environment variables apply only to new deployments, so redeploy after adding or changing them.
3. Deploy. Reports name the commit from Vercel's `VERCEL_GIT_COMMIT_SHA` (a system environment variable Vercel exposes by default). Vercel detects Next.js, installs with pnpm 10 from `pnpm-lock.yaml`, and uses Node.js 24 from `engines`.
4. Under **Settings → Deployment Protection**, keep Vercel Authentication on **Standard Protection**. It puts Vercel's own login in front of preview and generated deployment URLs, but not the production domain, which the access password protects. **All Deployments** would also put it in front of the production domain, so everyone you share with would need a Vercel account (on Hobby, only one person besides you can be given access).
5. Recommended: under **Firewall → Configure → + New Rule**, add a rule: if *Request Path* equals `/login` and *Method* equals `POST`, then *Rate Limit* with a fixed window of 60 seconds, 10 requests, keyed by IP, responding with 429. Select **Review Changes**, then **Publish**. This limits sign-in attempts across all server instances; Hobby includes one rate-limit rule per project.

The page's server function is capped at 40 seconds (`maxDuration` in `app/page.tsx`: with the data store, a settled market's lookup, the stock's history, and the benchmark can each wait for the one before), and the search routes at 60, since the first search on a new instance waits for its index. Each instance builds its own search indexes, so every instance that serves a stock search downloads the symbol lists once a day (2 Twelve Data requests). All timestamps are shown in New York time with the zone labeled, regardless of the server's time zone.

## Scope

This is an MVP. It has no trading functionality, user accounts, or automatic event-to-stock mapping.
