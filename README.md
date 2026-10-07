# EventLens

EventLens is a research dashboard that compares [Kalshi](https://kalshi.com) prediction-market data with stock-market data.

Pick a stock or ETF (search by ticker or name, e.g. `NVDA` or "nvidia") and a Kalshi market (search by keyword, e.g. "fed october", or paste a market ticker such as `KXFEDDECISION-26OCT-H25`), click **Analyze**, and EventLens shows:

- **Kalshi market:** title, implied probability, YES bid / ask, last price, 24-hour volume, open interest, 1-hour and 24-hour probability change, and an event-uncertainty score
- **Stock:** current price, daily change, volume (compared with average volume once the market has closed), and 30-day realized volatility (via [Twelve Data](https://twelvedata.com))
- **Charts:** Kalshi probability vs. stock return over the last 7 days, aligned on timestamps, plus the probability history and ~3 months of daily closes
- **Research:** how Kalshi probability changes relate to stock returns over 7, 30, or 90 days (hourly or daily; 90 days hourly by default): lead-lag correlation, rolling correlation, and an event study around Kalshi jumps, on raw or market-adjusted returns (net of SPY or another benchmark), with significance tests built for this data (one primary test; p-values and 95% intervals for every lag and event-study bar; Holm and Benjamini–Hochberg corrections), sample sizes, caveats, and a CSV export of the aligned data

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
pnpm test    # unit tests (Vitest)
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
- **Open markets only.** To analyze a closed or settled market, paste its ticker.

Use a **market** ticker, not an event or series ticker. Market tickers appear in Kalshi market URLs and API responses, and look like `KXFEDDECISION-26OCT-H25` or `KXRECSSNBER-27`. The example buttons in the app use real markets, but markets close over time, so an example may stop working.

### Typed text that isn't a ticker

Some names and keywords also look like tickers ("nvidia", "recession"). Analyzing one would only fail, and would spend Twelve Data requests on the stock side. So when a field's search has already shown that its text isn't a listed ticker, **Analyze** asks to pick from the list instead (e.g. "Pick one from the list, such as NVDA (NVIDIA Corporation)"). Tickers the search hasn't seen go straight through.

## Recent analyses and sharing

- **Links:** every analysis has its own URL (`/?stock=NVDA&kalshi=KXFEDDECISION-26OCT-H25`). **Copy link** above the results copies it, and a shared link's tab title names the analysis. Opening a link requires signing in, and then goes straight to the analysis. Back and Forward move between analyses, and the fields follow.
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
- **Typical sample sizes:** 7 days hourly ≈ 30 intervals, 30 days hourly ≈ 120, 90 days hourly ≈ 370, 30 days daily ≈ 20, 90 days daily ≈ 60. The daily view isn't offered for 7 days (about 5 closes).
- **Market lifetime:** a market younger than the window covers less of it (the page shows the actual date range). Stock data covers the last ~90 days, so a market that settled before then won't overlap.
- **History depth:** Kalshi returns at most 10,000 candles per request, so 90 days (plus a week before, to know the probability in effect when the window starts) is one request of hourly candles. The Twelve Data free plan returns up to 900 30-minute bars (about 70 sessions) of regular-hours data.

### Market-adjusted returns

A Kalshi move and a stock move in the same hour can both be the whole market moving. **Returns: Market-adjusted** takes out what a benchmark explains, so what's left is how the stock moved differently from the market. It applies to the same-interval correlation, lead-lag, rolling correlation, and the event study. **Market-adjusted is the default**, since the primary test always uses market-adjusted returns. When adjustment isn't possible (the stock is the benchmark, the benchmark didn't load, or there are too few prices to estimate beta), the page shows raw returns and says why under the toggles; picking Raw shows the stock's own returns.

- **Benchmark:** SPY by default; any US stock or ETF can be picked in the Research section with the same search field as the form (e.g. QQQ, or a sector ETF such as XLK or XLF). It resets to SPY for each analysis and isn't part of the shareable link. Its bars are read at exactly the stock's observation times (top-of-hour closes, and session closes stamped the same way as the stock's); an interval without a benchmark price at both ends is left out of the adjusted results and counted. Only benchmark bars that had closed at least 5 minutes before they were fetched are used.
- **Market model:** OLS of the stock's log return on the benchmark's, *r = α + β·r_benchmark*, over **every interval in the loaded 90 days** at the chosen resolution where both have prices (Kalshi isn't needed): about 380 hourly or 62 daily intervals. The page shows β (with a 95% interval), α, R², and n, and says that they come from the full 90 days whatever window is selected. The **abnormal return** is *r − α − β·r_benchmark*.
- **Event study:** its β and α are fitted the same way but leaving out every interval within the event window (6 bars hourly, 5 sessions daily, each side) of every jump at or above the chosen size anywhere in the 90 days, so the jumps being studied don't shape β. Paths are the cumulative abnormal log return, *ln(S/S₀) − β·ln(B/B₀) − α·bars*; the baseline is adjusted the same way. With large or frequent jumps (e.g. daily, 3 pp) too few intervals may be left, and the page says so.
- **Simple excess return**, *r − r_benchmark* (β = 1, α = 0), is shown next to the beta-adjusted and raw results for the same-interval correlation and the event study's end values.
- **Kalshi with the market held fixed:** OLS of the stock's return (%) on the benchmark's return (%) and the Kalshi change (pp) over the selected window, reporting the Kalshi coefficient (stock return per 1 pp), a 95% interval, and a p-value. The p-value and interval come from **the same wild cluster bootstrap as the primary test** (see [Statistical tests](#statistical-tests)), with every coefficient, the benchmark's included, refitted in every draw. Its statistic is the coefficient's t with Newey–West standard errors (Bartlett weights, ⌊4(n/100)^{2/9}⌋ lags, 3–5 here) and an HC3-style leverage correction:
  - Stock moves are larger in the hours news moves Kalshi, so ordinary standard errors (which assume constant variance) are too small.
  - Kalshi often reprices over several hours, and the Newey–West sum covers that autocorrelation. Lags pair intervals exactly that many grid slots apart, so no lag reaches across a night or a missing session.
  - Kalshi doesn't move in most hours, so the coefficient rests on the few intervals where it did. OLS fits those high-leverage points closely, which makes their residuals understate the noise; dividing each residual by (1 − leverage), as HC3 does, corrects for that.
  - It's a cross-check of the primary test (which uses β from the full 90 days), shown with an uncorrected p-value. With fewer than 8 sessions (or runs of days) there's no p-value or interval, as for the correlations.
  - **Newey–West cross-check:** the same t read from a t distribution with n − 3 degrees of freedom is shown next to it (not when Kalshi moved in fewer than 10 intervals, or when the bootstrap gives no p-value). That large-sample approximation rejects too often when the stock is more volatile in the hours Kalshi moves: in the test suite's simulations with 21 hourly sessions and no relationship, 8.0% of data sets (32 of 400, ± 1.4), against 4.5% for the bootstrap on the same data sets (see [Statistical tests](#statistical-tests)).

Caveats shown on the page:

- If the event moves the whole market (an index level, the Fed, a recession), adjusting removes the part of the move the stock shares with the market, which may be the very effect being studied. The page flags when Kalshi changes correlate with the benchmark's returns (wild bootstrap p < 0.05, uncorrected).
- A benchmark that holds the stock (NVDA is in SPY and QQQ, and a large weight in tech sector ETFs) absorbs part of the stock's own move. A benchmark that explains almost all of it (R² ≥ 0.95, e.g. VOO for SPY) leaves mostly noise, and the page says so. When the stock is the benchmark, adjustment is unavailable.
- Hourly β is intraday (trading hours only) and daily β includes overnight moves, so they differ. For thinly traded stocks the last trade in an hour can be stale, which pulls hourly β toward 0.
- β is assumed stable over the 90 days. Event-study windows span nights and weekends, and β and α apply per bar there too.

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
- **On market-adjusted returns, β and α are refitted in every draw** (`lib/analytics/wild-bootstrap.ts`), for the primary test and every lag of the market-adjusted lead-lag chart. Each draw rebuilds the stock's returns over the whole market model sample (every interval of the loaded 90 days, each of its sessions with its own weight), refits the market model, recomputes the abnormal returns, and recomputes the correlation's t. Under "slope = θ₀" the rebuilt returns carry an effect θ₀/κ along Kalshi's changes, where κ is the share of Kalshi's variation the market model leaves in place: when Kalshi moves with the benchmark, the market model absorbs part of any effect, so the abnormal returns show only κ of it. Everything stays a closed-form function of the slope being tested, so this costs a few milliseconds. `wild-bootstrap.test.ts` checks the closed form against refitting both regressions with `ols` draw by draw, and checks that raw-returns results are exactly as before. The regression above uses the same engine with the benchmark's return as a second regressor.
- Treating β as known was conservative, not optimistic: β is fitted on 90 days that include the window, so its error partly cancels the noise the test sees. In the simulations below, the fixed-β version came out below 0.05 in only 1.7% of data sets over 90 hourly days when Kalshi tracks the benchmark; refitting brings that to 4.7%.
- Effective n is Bartlett's *n* / (1 + 2 Σ ρₓ(j) ρᵧ(j)) over the Newey–West lags, autocorrelations pairing slots exactly *j* apart. It's for reading the sample size; the tests don't use it.

**Smallest detectable correlation** (`lib/analytics/power.ts`). When the primary test isn't significant, the page says how large a same-interval correlation this sample could have detected 80% of the time, so a non-significant result isn't read as evidence of no link:

- 999 simulated versions of the sample keep Kalshi's changes, the benchmark's returns, the sessions, and the stock's residual volatility (the market model's residuals, each session with a fresh Webb weight), with an effect built in along Kalshi's changes. Each is tested the way the page tests the real sample: α and β refitted, the same statistic, and a bootstrap critical value. Rerunning a 999-draw bootstrap inside each would cost a million draws, so critical values use the **warp-speed method** (Giacomini, Politis & White 2013): one inner bootstrap draw per simulated sample, from its own restricted residuals.
- **One sample's volatility is itself uncertain**: with heavy-tailed returns, the volatility in the few hours Kalshi moved is estimated from a handful of intervals. Taking it as known was optimistic: in development runs (not in the test suite), effects of the size it reported were detected only about 71–77% of the time in fresh samples. So the power is averaged over that uncertainty: the statistic's score variance is resampled by session (200 resamples), and since the test is scale-free, noise *k* times larger is the same as an effect *k* times smaller. Few sessions or a few dominant hours then widen the spread and raise the detectable size.
- The figure is the smallest |r| reaching 80% in both directions, on the scale *r* = θ·*s_x* / √(θ²*s_x*² + *s_y*²). It's a rough guide, and the page says so. **Above ±0.8 it isn't given as a number**: there the power curve flattens and the simulation stops being reliable, so the page says only correlations stronger than about ±0.8 could be detected. With 30 days of daily data that's the usual case, and **when a 30-day daily window does get a number, the page says it's unreliable**, with the measured rate below.
- It's computed only when the primary result isn't significant, from data already on the page.

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

Not in the test suite: comparisons with the methods tried and dropped (the old ±1.96/√n band, shuffling Kalshi between sessions, a placebo-window event test, and plain percentile event intervals). Those ran during development: the tests over-rejected, mostly when volatility was shared, and the percentile intervals under-covered. They aren't reproducible from the repository, so no figures are given here. An independent Python reimplementation (numpy and statsmodels, refitting every bootstrap draw instead of using the closed form) reproduced the p-values, intervals, Holm and BH adjustments, effective n, and random-number stream exactly. That check predates refitting β in every draw; raw-returns results are unchanged since (pinned in `wild-bootstrap.test.ts`), and the new closed form is checked in the test suite against refitting draw by draw.

**Limitations.**

- The wild bootstrap treats sessions (hourly) or runs of 2–3 days (daily) as independent and residual signs as symmetric. Daily autocorrelation longer than a run isn't covered.
- β's uncertainty is carried into the primary test, the market-adjusted lead-lag chart, and the regression, but **the event study still treats its β as known** (fitted outside the jump windows). The rolling correlation is descriptive and has no test.
- The smallest detectable correlation is a rough guide: it comes from one sample's volatility, averaged over how uncertain that is. In validation it was somewhat optimistic with 21 hourly sessions (75%), and unreliable with 20 daily intervals (45%).
- Intervals on the correlation scale use the sample standard deviations, ignoring their own uncertainty.
- The sign-flip test assumes deviations from the baseline would be symmetric if jumps were unrelated to the stock; skewed returns weaken that. The baseline is treated as fixed.
- Holm is conservative because neighboring lags and bars share data; BH assumes they're positively dependent, which is plausible but not guaranteed.
- Corrections apply within each chart's family, not across the page or across the settings tried.
- Small samples can't show much: 30 days of daily data has about 10 runs of days, and most of its intervals span nearly everything.

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
  login/              Sign-in page, and the sign-in and sign-out actions
  api/search/         Search API routes: stocks/ and kalshi/ (GET ?q=…)
  api/benchmark/      Research benchmark prices (GET ?symbol=…)
components/           UI components (cards, form, panels)
  auth/               Sign-in form and Sign out button
  analysis/           Loading analyses, shareable links, Copy link, recent analyses
  charts/             Recharts client components
  research/           Research panel (window, resolution, raw or market-adjusted returns, benchmark, analyses, CSV download)
  search/             Stock and Kalshi search fields (comboboxes)
lib/
  auth/               Access gate: sessions, password check, page and API route guards
  kalshi/             Kalshi API client, market search index, normalized types (server-only)
  market-data/        Twelve Data client, symbol lists and search, popular symbols, research benchmarks (server-only)
  analytics/          Pure metric, alignment, research, regression, and significance-test functions (and the CSV export)
  search/             Search contract: result types, query validation, error responses
  validation.ts       Ticker input validation
  format.ts           Number and date formatting
proxy.ts              Sends requests without a session to /login (API routes get a 401)
```

Third-party API calls live in `lib/kalshi` and `lib/market-data`, run only on the server (enforced with `server-only`), and return normalized TypeScript types. The UI never calls third-party APIs directly: the search fields call this app's `/api/search/…` routes, and picking a benchmark calls `/api/benchmark`.

## Access

EventLens shows Twelve Data's data, and the free Twelve Data plan doesn't allow displaying it publicly, so every page and API route requires a signed-in session.

- **Signing in.** Anyone who isn't signed in is sent to `/login` and asked for the access password (`ACCESS_PASSWORD`). After signing in they land on the page they asked for, so a shared analysis link still opens that analysis. A sign-in lasts 30 days in that browser; **Sign out** (top right) ends it sooner.
- **Giving and removing access.** Share the password with the people you want to let in. To remove someone, change `ACCESS_PASSWORD` in Vercel and redeploy: that signs everyone out, and you give the new password to the people who should keep access. Changing `AUTH_SECRET` also signs everyone out, without changing the password. **Sign out** only ends the session in that browser.
- **What's protected.** `proxy.ts` (Next.js 16's name for middleware) runs on every request except build assets (`/_next/static/…` and `/favicon.ico`). Pages redirect to `/login`, and `/api/…` routes answer `401` with `{"error":{"code":"unauthorized",…}}`. The dashboard page and each API route also check the session themselves, so a gap in the proxy doesn't expose data. The CSV export is built in the browser from data that's already on the page, so it needs no separate check. The proxy covers new pages and routes automatically; give them their own check too, with `requirePageSession()` (pages) or `rejectUnlessSignedIn(request.cookies)` (API routes) from `lib/auth/`.
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

   Add `ACCESS_PASSWORD` and `AUTH_SECRET` to both **Production and Preview** and mark them **Sensitive**. Without them a deployment locks: nobody can sign in. Changes to environment variables apply only to new deployments, so redeploy after adding or changing them.
3. Deploy. Vercel detects Next.js, installs with pnpm 10 from `pnpm-lock.yaml`, and uses Node.js 24 from `engines`.
4. Under **Settings → Deployment Protection**, keep Vercel Authentication on **Standard Protection**. It puts Vercel's own login in front of preview and generated deployment URLs, but not the production domain, which the access password protects. **All Deployments** would also put it in front of the production domain, so everyone you share with would need a Vercel account (on Hobby, only one person besides you can be given access).
5. Recommended: under **Firewall → Configure → + New Rule**, add a rule: if *Request Path* equals `/login` and *Method* equals `POST`, then *Rate Limit* with a fixed window of 60 seconds, 10 requests, keyed by IP, responding with 429. Select **Review Changes**, then **Publish**. This limits sign-in attempts across all server instances; Hobby includes one rate-limit rule per project.

The page's server function is capped at 30 seconds (`maxDuration` in `app/page.tsx`), and the search routes at 60, since the first search on a new instance waits for its index. Each instance builds its own search indexes, so every instance that serves a stock search downloads the symbol lists once a day (2 Twelve Data requests). All timestamps are shown in New York time with the zone labeled, regardless of the server's time zone.

## Scope

This is an MVP. It has no trading functionality, user accounts, database, or automatic event-to-stock mapping.
