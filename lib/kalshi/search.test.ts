import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RawEvent, RawEventsPage, RawMarket } from "./types";

// server-only throws outside React's server environment; the module only uses it as a marker.
vi.mock("server-only", () => ({}));

const NOW = Date.UTC(2026, 8, 29, 16, 0, 0);
const MINUTE_MS = 60_000;

interface MarketFixture {
  ticker: string;
  title: string;
  yes?: string;
  status?: string;
  bid?: number;
  ask?: number;
  last?: number;
  volume?: number;
  close?: string;
}

const dollars = (v: number | undefined) => (v === undefined ? undefined : v.toFixed(4));

function rawEvent(ticker: string, title: string, category: string, markets: MarketFixture[]): RawEvent {
  return {
    event_ticker: ticker,
    series_ticker: ticker.split("-")[0],
    title,
    sub_title: "",
    category,
    markets: markets.map(
      (m): RawMarket => ({
        ticker: m.ticker,
        event_ticker: ticker,
        title: m.title,
        yes_sub_title: m.yes ?? "",
        status: m.status ?? "active",
        yes_bid_dollars: dollars(m.bid ?? 0.4),
        yes_ask_dollars: dollars(m.ask ?? 0.44),
        last_price_dollars: dollars(m.last ?? 0.42),
        volume_24h_fp: String(m.volume ?? 0),
        open_interest_fp: "0",
        close_time: m.close ?? "2026-10-28T18:00:00Z",
      }),
    ),
  };
}

const FED = rawEvent("KXFEDDECISION-26OCT", "Fed decision in October 2026", "Economics", [
  { ticker: "KXFEDDECISION-26OCT-H25", title: "Will the Fed hike rates by 25bps in October 2026?", bid: 0.03, ask: 0.05, volume: 1000 },
  { ticker: "KXFEDDECISION-26OCT-H0", title: "Will the Fed hold rates in October 2026?", bid: 0.8, ask: 0.84, volume: 5000 },
  { ticker: "KXFEDDECISION-26OCT-C25", title: "Will the Fed cut rates by 25bps in October 2026?", bid: 0.1, ask: 0.14, volume: 3000 },
  { ticker: "KXFEDDECISION-26OCT-C50", title: "Will the Fed cut rates by 50bps in October 2026?", status: "finalized" },
]);

const POPE = rawEvent("KXNEWPOPE-70", "Who will the next Pope be?", "Elections", [
  { ticker: "KXNEWPOPE-70-PPAR", title: "Who will the next Pope be?", yes: "Pietro Parolin", volume: 20 },
  // An empty book and no trades: no probability.
  { ticker: "KXNEWPOPE-70-LANT", title: "Who will the next Pope be?", yes: "Luis Antonio Tagle", bid: 0, ask: 1, last: 0, volume: 10 },
]);

const ROMANIA = rawEvent("KXNEXTROMANIAPM-45JAN01", "Who will be the next new Prime Minister of Romania?", "Elections", [
  {
    ticker: "KXNEXTROMANIAPM-45JAN01-MISA",
    title: "Will Mugur Isărescu be the next Prime Minister of Romania?",
    yes: "Mugur Isărescu",
  },
]);

const NASDAQ = rawEvent("KXNASDAQ100Y-26DEC31H1600", "Nasdaq-100 at the end of 2026", "Financials", [
  { ticker: "KXNASDAQ100Y-26DEC31H1600-T33000", title: "Will the Nasdaq-100 be above 33,000 at the end of 2026?", yes: "Above 33,000", bid: 0, ask: 1, last: 0.37 },
]);

const EVENTS = [FED, POPE, ROMANIA, NASDAQ];

type Reply = Response | RawEventsPage;

/** Kalshi's /events, one page per entry of `pages`; the cursor is the next page's index. */
function stubEvents(pages: RawEvent[][] | ((page: number) => Reply | Promise<Reply>)) {
  const requests: { url: URL; at: number }[] = [];
  vi.stubGlobal("fetch", async (input: string | URL) => {
    const url = new URL(String(input));
    requests.push({ url, at: Date.now() });
    const page = Number(url.searchParams.get("cursor") ?? 0);
    if (typeof pages === "function") {
      const reply = await pages(page);
      return reply instanceof Response ? reply : Response.json(reply);
    }
    return Response.json({ events: pages[page], cursor: page + 1 < pages.length ? String(page + 1) : "" });
  });
  return requests;
}

/** A fresh copy of the module, so each test starts without an index. */
async function loadSearch() {
  vi.resetModules();
  return import("./search");
}

type SearchModule = Awaited<ReturnType<typeof loadSearch>>;

/** Runs fake timers (the pause between index pages) until `promise` settles. */
async function settle<T>(promise: Promise<T>): Promise<T> {
  let done = false;
  promise.then(
    () => (done = true),
    () => (done = true),
  );
  while (!done) await vi.advanceTimersByTimeAsync(50);
  return promise;
}

async function results(mod: SearchModule, query: string) {
  const found = await settle(mod.searchKalshiMarkets(query));
  if (!found.ok) throw new Error(`Expected results, got ${found.error.code}`);
  return found.data;
}

const tickers = (list: { ticker: string }[]) => list.map((r) => r.ticker);

beforeEach(() => {
  vi.useFakeTimers({ now: NOW });
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("searchWords", () => {
  it("lowercases, strips accents, keeps decimals, and drops thousands separators", async () => {
    const { searchWords } = await loadSearch();
    expect(searchWords("Mugur Isărescu")).toEqual(["mugur", "isarescu"]);
    expect(searchWords("Above $33,000 or 4.25%? KXFED-26DEC-T4.00")).toEqual([
      "above",
      "33000",
      "or",
      "4.25",
      "kxfed",
      "26dec",
      "t4.00",
    ]);
  });
});

describe("searchKalshiMarkets", () => {
  it("pages through open events with their markets, spacing requests out", async () => {
    const requests = stubEvents([[FED], [POPE], [ROMANIA, NASDAQ]]);
    const mod = await loadSearch();
    await results(mod, "will");

    expect(requests).toHaveLength(3);
    for (const { url } of requests) {
      expect(url.pathname).toBe("/trade-api/v2/events");
      expect(url.searchParams.get("status")).toBe("open");
      expect(url.searchParams.get("with_nested_markets")).toBe("true");
      expect(url.searchParams.get("limit")).toBe("200");
    }
    expect(requests.map(({ url }) => url.searchParams.get("cursor"))).toEqual([null, "1", "2"]);
    expect(requests[1].at - requests[0].at).toBeGreaterThanOrEqual(mod.MIN_REQUEST_INTERVAL_MS);
    expect(requests[2].at - requests[1].at).toBeGreaterThanOrEqual(mod.MIN_REQUEST_INTERVAL_MS);
  });

  it("returns open markets with their event, category, close time, and probability", async () => {
    stubEvents([EVENTS]);
    const mod = await loadSearch();
    const fed = await results(mod, "fed");

    expect(tickers(fed)).not.toContain("KXFEDDECISION-26OCT-C50"); // finalized
    expect(fed.find((r) => r.ticker === "KXFEDDECISION-26OCT-H0")).toEqual({
      ticker: "KXFEDDECISION-26OCT-H0",
      title: "Will the Fed hold rates in October 2026?",
      eventTitle: "Fed decision in October 2026",
      category: "Economics",
      status: "open",
      closeTime: "2026-10-28T18:00:00Z",
      probability: expect.closeTo(0.82, 12),
    });
    // A one-sided book falls back to the last trade, like the dashboard.
    const [nasdaq] = await results(mod, "nasdaq");
    expect(nasdaq.probability).toBe(0.37);
  });

  it("gives markets whose titles repeat within an event their YES side as a subtitle, and has no probability without a quote", async () => {
    stubEvents([EVENTS]);
    const mod = await loadSearch();
    const pope = await results(mod, "pope");

    expect(pope.map((r) => [r.title, r.subtitle, r.probability])).toEqual([
      ["Who will the next Pope be?", "Pietro Parolin", expect.closeTo(0.42, 12)],
      ["Who will the next Pope be?", "Luis Antonio Tagle", null],
    ]);
    // A unique title is enough on its own, even when the market has a YES side.
    const [romania] = await results(mod, "romania");
    expect(romania.title).toBe("Will Mugur Isărescu be the next Prime Minister of Romania?");
    expect(romania).not.toHaveProperty("subtitle");
    const [nasdaq] = await results(mod, "nasdaq");
    expect(nasdaq).not.toHaveProperty("subtitle");
  });

  it("matches every word as the start of a word in the market, event, category, or ticker", async () => {
    stubEvents([EVENTS]);
    const mod = await loadSearch();

    expect(tickers(await results(mod, "fed hik"))).toEqual(["KXFEDDECISION-26OCT-H25"]);
    expect(await results(mod, "fed pope")).toEqual([]);
    expect(await results(mod, "ed")).toEqual([]); // "ed" starts no word, though "Fed" contains it
    expect(tickers(await results(mod, "PARolin"))).toEqual(["KXNEWPOPE-70-PPAR"]); // YES side, any case
    expect(tickers(await results(mod, "isarescu"))).toEqual(["KXNEXTROMANIAPM-45JAN01-MISA"]); // accents
    expect(tickers(await results(mod, "nasdaq 33000"))).toEqual(["KXNASDAQ100Y-26DEC31H1600-T33000"]); // "33,000"
    expect(tickers(await results(mod, "economics"))).toHaveLength(3); // category
    expect(tickers(await results(mod, "KXNEWPOPE"))).toHaveLength(2); // ticker
  });

  it("ranks a pasted ticker first, then stronger matches, then the most traded", async () => {
    stubEvents([EVENTS]);
    const mod = await loadSearch();

    // All three open Fed markets match "fed" equally, so 24h volume orders them.
    expect(tickers(await results(mod, "fed"))).toEqual([
      "KXFEDDECISION-26OCT-H0",
      "KXFEDDECISION-26OCT-C25",
      "KXFEDDECISION-26OCT-H25",
    ]);
    expect(tickers(await results(mod, "kxfeddecision-26oct-h25"))[0]).toBe("KXFEDDECISION-26OCT-H25");
  });

  it("ranks a whole-word match above a prefix match", async () => {
    const whole = rawEvent("KXA-1", "Rates", "Economics", [{ ticker: "KXA-1-X", title: "Will the Fed hold?", volume: 1 }]);
    const prefix = rawEvent("KXB-1", "Chair", "Economics", [
      { ticker: "KXB-1-X", title: "Will the Federal Reserve chair resign?", volume: 999 },
    ]);
    stubEvents([[prefix, whole]]);
    const mod = await loadSearch();
    expect(tickers(await results(mod, "fed"))).toEqual(["KXA-1-X", "KXB-1-X"]);
  });

  it("ranks a match in the market's own title above one only in its event title", async () => {
    const byTitle = rawEvent("KXA-1", "Something else", "World", [{ ticker: "KXA-1-X", title: "Will rates fall?", volume: 1 }]);
    const byEvent = rawEvent("KXB-1", "Rates this year", "World", [{ ticker: "KXB-1-X", title: "Above 4%?", volume: 999 }]);
    stubEvents([[byEvent, byTitle]]);
    const mod = await loadSearch();
    expect(tickers(await results(mod, "rates"))).toEqual(["KXA-1-X", "KXB-1-X"]);
  });

  it(`returns at most MAX_SEARCH_RESULTS results`, async () => {
    const strikes = Array.from({ length: 30 }, (_, i) => ({ ticker: `KXBTC-26OCT-T${i}`, title: "Bitcoin above?", volume: i }));
    stubEvents([[rawEvent("KXBTC-26OCT", "Bitcoin price", "Crypto", strikes)]]);
    const mod = await loadSearch();
    const found = await results(mod, "bitcoin");
    expect(found).toHaveLength(mod.MAX_SEARCH_RESULTS);
    expect(found[0].ticker).toBe("KXBTC-26OCT-T29");
  });

  it("leaves out a market once its close time passes, even before the index is rebuilt", async () => {
    const soon = new Date(NOW + MINUTE_MS).toISOString();
    stubEvents([[rawEvent("KXSOON-1", "Closing soon", "World", [{ ticker: "KXSOON-1-A", title: "Soon?", close: soon }])]]);
    const mod = await loadSearch();
    expect(await results(mod, "soon")).toHaveLength(1);
    vi.setSystemTime(NOW + 2 * MINUTE_MS);
    expect(await results(mod, "soon")).toEqual([]);
  });

  it("skips an event that appears on two pages", async () => {
    stubEvents([[FED], [FED, POPE]]);
    const mod = await loadSearch();
    expect(await results(mod, "fed")).toHaveLength(3);
  });

  it("stops paging after MAX_INDEX_PAGES and warns", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const requests = stubEvents((page) => ({ events: [rawEvent(`KXE-${page}`, "Endless", "World", [{ ticker: `KXE-${page}-A`, title: "Endless?" }])], cursor: String(page + 1) }));
    const mod = await loadSearch();
    expect(await results(mod, "endless")).toHaveLength(mod.MAX_SEARCH_RESULTS);
    expect(requests).toHaveLength(mod.MAX_INDEX_PAGES);
    expect(warn).toHaveBeenCalledOnce();
  });
});

describe("the market index cache", () => {
  it("shares one build between concurrent searches and reuses it while fresh", async () => {
    const requests = stubEvents([EVENTS]);
    const mod = await loadSearch();
    const [fed, pope] = await Promise.all([settle(mod.searchKalshiMarkets("fed")), settle(mod.searchKalshiMarkets("pope"))]);
    expect(fed.ok && pope.ok).toBe(true);
    expect(requests).toHaveLength(1);

    vi.setSystemTime(NOW + mod.INDEX_FRESH_MS - 1);
    await results(mod, "romania");
    expect(requests).toHaveLength(1);
    expect(mod.pendingKalshiIndexRefresh()).toBeUndefined();
  });

  it("answers from a stale index while one background refresh replaces it", async () => {
    let bid = 0.8;
    let gate: Promise<void> = Promise.resolve();
    const requests = stubEvents(async () => {
      await gate;
      const markets = [{ ticker: "KXFED-1-A", title: "Fed?", bid, ask: bid + 0.02 }];
      return { events: [rawEvent("KXFED-1", "Fed", "Economics", markets)], cursor: "" };
    });
    const mod = await loadSearch();
    expect((await results(mod, "fed"))[0].probability).toBeCloseTo(0.81, 12);

    bid = 0.5;
    let release!: () => void;
    gate = new Promise((resolve) => (release = resolve));
    vi.setSystemTime(NOW + mod.INDEX_FRESH_MS);
    // Kalshi hasn't answered the refresh, yet the search returns the old index at once.
    expect((await mod.searchKalshiMarkets("fed")).ok).toBe(true);
    const refresh = mod.pendingKalshiIndexRefresh();
    expect(refresh).toBeInstanceOf(Promise);
    expect((await results(mod, "fed"))[0].probability).toBeCloseTo(0.81, 12);

    release();
    await settle(refresh!);
    expect((await results(mod, "fed"))[0].probability).toBeCloseTo(0.51, 12);
    expect(requests).toHaveLength(2);
  });

  it("reports Kalshi's rate limit and doesn't ask again until the backoff passes", async () => {
    const requests = stubEvents(() => Response.json({ error: "too many requests" }, { status: 429 }));
    const mod = await loadSearch();

    const first = await settle(mod.searchKalshiMarkets("fed"));
    expect(first).toMatchObject({ ok: false, error: { code: "upstream_rate_limited" } });
    vi.setSystemTime(NOW + mod.FAILED_BUILD_BACKOFF_SEC * 1000 - 1);
    expect(await settle(mod.searchKalshiMarkets("fed"))).toEqual(first);
    expect(requests).toHaveLength(1);

    vi.setSystemTime(NOW + mod.FAILED_BUILD_BACKOFF_SEC * 1000);
    await settle(mod.searchKalshiMarkets("fed"));
    expect(requests).toHaveLength(2);
  });

  it("describes timeouts and other failures", async () => {
    stubEvents(() => {
      throw new DOMException("The operation timed out.", "TimeoutError");
    });
    let mod = await loadSearch();
    expect(await settle(mod.searchKalshiMarkets("fed"))).toMatchObject({ ok: false, error: { code: "upstream_timeout" } });

    stubEvents(() => new Response("<html>Bad gateway</html>", { status: 502 }));
    mod = await loadSearch();
    expect(await settle(mod.searchKalshiMarkets("fed"))).toMatchObject({ ok: false, error: { code: "upstream_unavailable" } });
  });

  it("keeps serving the last index while refreshes fail, until it's too old", async () => {
    let failing = false;
    stubEvents(() => (failing ? new Response("down", { status: 500 }) : { events: [FED], cursor: "" }));
    const mod = await loadSearch();
    await results(mod, "fed");

    failing = true;
    vi.setSystemTime(NOW + mod.INDEX_FRESH_MS);
    const stale = mod.searchKalshiMarkets("fed");
    const refresh = mod.pendingKalshiIndexRefresh();
    const staleResult = await stale;
    expect(staleResult.ok && staleResult.data).toHaveLength(3);
    expect(await settle(refresh!)).toMatchObject({ ok: false });
    expect(await results(mod, "fed")).toHaveLength(3);

    vi.setSystemTime(NOW + mod.INDEX_MAX_AGE_MS);
    expect(await settle(mod.searchKalshiMarkets("fed"))).toMatchObject({ ok: false, error: { code: "upstream_unavailable" } });
  });
});
