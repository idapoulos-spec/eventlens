-- EventLens data store: what to collect, each collection run and what it covered, and the
-- collected Kalshi candles and stock bars.
--
-- Conventions (see db/README.md):
-- - Every time is timestamptz, an absolute instant. Roles default to TimeZone 'UTC' (see
--   lib/store/migrate.ts), so times also print in UTC.
-- - Kalshi prices are integer micro-dollars: 1 = $0.000001, so a YES price of $0.45 is 450000.
--   Kalshi quotes up to 6 decimals. Contract counts are integer hundredths: "10.00" is 1000.
-- - Rows are never deleted. Re-fetching a bar updates it only if a value changed, and sets
--   updated_at when it does.
-- - The roles eventlens_app and eventlens_collector exist before this runs (scripts/migrate.ts).

-- Only the owner creates objects.
revoke create on schema public from public;
grant usage on schema public to eventlens_app, eventlens_collector;

create domain micro_dollars as integer check (value between 0 and 1000000);
create domain hundredths as bigint check (value >= 0);

-- ---- What to collect: edited with `pnpm db:watchlist` (owner only) ----

create table watchlist (
  id integer generated always as identity primary key,
  kind text not null check (kind in ('kalshi_series', 'kalshi_event', 'kalshi_market', 'stock')),
  -- A Kalshi series, event, or market ticker, or a stock symbol. Uppercase.
  key text not null check (key <> '' and key = upper(key)),
  -- Kalshi candle periods in minutes ('60', '1440'), or Twelve Data intervals ('30min', '1day').
  intervals text[] not null check (cardinality(intervals) > 0),
  active boolean not null default true,
  note text,
  added_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (kind, key),
  check (
    (kind <> 'stock' and intervals <@ array['60', '1440'])
    or (kind = 'stock' and intervals <@ array['30min', '1day'])
  )
);

-- ---- Collection runs, and the time ranges each one fetched completely ----

create table collection_runs (
  id integer generated always as identity primary key,
  collector text not null check (collector in ('kalshi', 'stocks')),
  mode text not null check (mode in ('incremental', 'backfill', 'repair')),
  -- schedule: GitHub Actions cron; manual: workflow_dispatch; local: run from a laptop.
  trigger text not null check (trigger in ('schedule', 'manual', 'local')),
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  status text not null default 'running' check (status in ('running', 'ok', 'partial', 'failed')),
  requests integer not null default 0 check (requests >= 0),
  -- Twelve Data credits spent. Kalshi requests cost none.
  credits integer not null default 0 check (credits >= 0),
  rows_inserted integer not null default 0 check (rows_inserted >= 0),
  rows_changed integer not null default 0 check (rows_changed >= 0),
  -- Fixed wording, never an upstream response or anything with a secret in it.
  error text,
  check ((status = 'running') = (finished_at is null))
);

-- A row means: every bar of `interval` for `series_key` whose time falls in `covered` was
-- requested, and everything returned is stored. Bars are placed by their end time (Kalshi's
-- end_period_ts; a stock bar's bar_end). Ranges are half-open, [from, to). Kalshi writes a
-- candle only when something changes, so a missing candle inside a covered range is not a gap;
-- a gap is time no successful fetch covered (lib/store/runs.ts: findGaps).
create table fetch_coverage (
  id integer generated always as identity primary key,
  run_id integer not null references collection_runs (id),
  source text not null check (source in ('kalshi', 'twelve_data')),
  -- A Kalshi market ticker or a stock symbol.
  series_key text not null,
  interval text not null check (interval in ('60', '1440', '30min', '1day')),
  covered tstzrange not null check (
    not isempty(covered) and lower_inc(covered) and not upper_inc(covered)
    and not lower_inf(covered) and not upper_inf(covered)
  ),
  rows integer not null check (rows >= 0),
  recorded_at timestamptz not null default now()
);
create index fetch_coverage_series on fetch_coverage (source, series_key, interval);

-- ---- Kalshi ----

create table kalshi_markets (
  id integer generated always as identity primary key,
  ticker text not null unique,
  event_ticker text not null,
  series_ticker text not null,
  title text,
  yes_sub_title text,
  status text not null,
  -- "yes", "no", … once settled.
  result text,
  open_time timestamptz,
  close_time timestamptz,
  settlement_ts timestamptz,
  -- Which endpoint the row was last read from: Kalshi moves markets settled before its archive
  -- cutoff to /historical (GET /historical/cutoff).
  source text not null check (source in ('live', 'historical')),
  -- The market object as Kalshi returned it, for fields without a column.
  raw jsonb not null,
  first_seen_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index kalshi_markets_series on kalshi_markets (series_ticker);
create index kalshi_markets_event on kalshi_markets (event_ticker);

-- One candlestick as Kalshi returned it (lib/kalshi/candles.ts normalizes the live and
-- historical shapes). Null means Kalshi left the value out: no bid or ask, or no trade in the period.
create table kalshi_candles (
  market_id integer not null references kalshi_markets (id),
  period_min smallint not null check (period_min in (60, 1440)),
  -- The end of the period. Kalshi stamps candles at their end.
  end_ts timestamptz not null,
  yes_bid_open micro_dollars,
  yes_bid_high micro_dollars,
  yes_bid_low micro_dollars,
  yes_bid_close micro_dollars,
  yes_ask_open micro_dollars,
  yes_ask_high micro_dollars,
  yes_ask_low micro_dollars,
  yes_ask_close micro_dollars,
  price_open micro_dollars,
  price_high micro_dollars,
  price_low micro_dollars,
  price_close micro_dollars,
  price_mean micro_dollars,
  -- The close of the last period with a trade.
  price_previous micro_dollars,
  volume hundredths,
  open_interest hundredths,
  source text not null check (source in ('live', 'historical')),
  fetched_at timestamptz not null,
  updated_at timestamptz,
  run_id integer not null references collection_runs (id),
  primary key (market_id, period_min, end_ts)
);

-- ---- Stocks (collection on hold until Twelve Data confirms storing its data is allowed) ----

create table stock_instruments (
  id integer generated always as identity primary key,
  symbol text not null unique,
  name text,
  exchange text,
  -- From Twelve Data's meta, e.g. America/New_York. Decides how bars are stamped (lib/market-data/session.ts).
  exchange_timezone text,
  currency text,
  first_seen_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- One settled bar. Intraday bars are unadjusted; daily bars are split-adjusted as of fetched_at
-- (Twelve Data adjusts daily history when a split happens).
create table stock_bars (
  instrument_id integer not null references stock_instruments (id),
  interval text not null check (interval in ('30min', '1day')),
  -- Twelve Data's datetime (requested in UTC): the bar's open, or 00:00 UTC of the trading date for daily bars.
  bar_start timestamptz not null,
  -- The bar's close: start + 30 minutes, or the session's actual close for daily bars.
  bar_end timestamptz not null,
  -- The exchange's local trading date.
  trade_date date not null,
  open double precision not null,
  high double precision not null,
  low double precision not null,
  close double precision not null,
  volume bigint check (volume >= 0),
  fetched_at timestamptz not null,
  updated_at timestamptz,
  run_id integer not null references collection_runs (id),
  primary key (instrument_id, interval, bar_start),
  check (bar_end > bar_start),
  check (open > 0 and high > 0 and low > 0 and close > 0 and low <= high)
);

-- ---- Privileges: the app reads; the collector reads and writes data, never the watchlist ----

grant select on all tables in schema public to eventlens_app, eventlens_collector;
grant insert, update on
  collection_runs, fetch_coverage, kalshi_markets, kalshi_candles, stock_instruments, stock_bars
  to eventlens_collector;

-- ---- The starting watchlist ----

insert into watchlist (kind, key, intervals, active, note) values
  ('kalshi_series', 'KXFEDDECISION', array['60', '1440'], true, 'Every Fed meeting and outcome, open and settled'),
  ('stock', 'SPY', array['30min', '1day'], false, 'On hold until Twelve Data confirms storing its data is allowed'),
  ('stock', 'QQQ', array['30min', '1day'], false, 'On hold until Twelve Data confirms storing its data is allowed'),
  ('stock', 'TLT', array['30min', '1day'], false, 'On hold until Twelve Data confirms storing its data is allowed'),
  ('stock', 'JPM', array['30min', '1day'], false, 'On hold until Twelve Data confirms storing its data is allowed'),
  ('stock', 'KRE', array['30min', '1day'], false, 'On hold until Twelve Data confirms storing its data is allowed'),
  ('stock', 'XLF', array['30min', '1day'], false, 'On hold until Twelve Data confirms storing its data is allowed'),
  ('stock', 'NVDA', array['30min', '1day'], false, 'On hold until Twelve Data confirms storing its data is allowed');
