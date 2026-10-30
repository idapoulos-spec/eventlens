// The scan's plain-English summary says what its results card shows. A finished scan against the
// fake world (its routes answered by their loaders, as in scan-report.test.tsx), its card rendered
// as the page renders it: the summary there must be the builder's for the same snapshot, and every
// number in it must be printed elsewhere on the card, unless the builder declares it (the count of
// other tests, or the rating's own threshold), each checked against its source.

import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EVIDENCE } from "@/lib/analytics/evidence";
import { linkSymbol, stubWorld, worldEvent, worldMarket } from "@/lib/history/test-world";
import { parseSpan } from "@/lib/scan/api";
import { SCAN_CANDIDATE_PATH, SCAN_PRICES_PATH } from "@/lib/scan/types";
import type { getScanPrices as GetScanPrices } from "@/lib/scan/prices";
import type { loadCandidateKalshi as LoadCandidateKalshi } from "@/lib/scan/load";
import type { tickerCandidates as TickerCandidates } from "@/lib/scan/candidates";
import type { ScanRun as ScanRunClass, ScanSnapshot } from "../scan/scanRunner";
import type { ScanResults as ScanResultsComponent } from "../scan/ScanPage";
import { numbersNotOn, textOf } from "../report/test-helpers";
import { ScanPlainSummary } from "./PlainEnglishCard";
import { scanPlainSummary, type PlainSummary } from "./summary";

vi.setConfig({ testTimeout: 120_000 });
vi.mock("server-only", () => ({}));
vi.mock("@/lib/store/db", () => ({ getAppSql: () => null }));

const NOW = Date.UTC(2026, 9, 7, 16, 40, 30);
const SCAN_MARKET = worldMarket("KXFEDDECISION-26OCT-H0", { status: "active", open: Date.UTC(2025, 4, 1), close: Date.UTC(2026, 9, 28, 18), archived: false });
/**
 * A market whose quotes move often enough for a rating (an effective 26 moves at 90 days): accuracy.test.tsx's
 * KXFEDDECISION-26DEC-T14, with its quotes, under a ticker outside SCAN_EVENT so the event keeps its five outcomes.
 */
const MOVING_MARKET = (() => {
  const m = worldMarket("KXFEDDECISION-26DEC-T14", { status: "active", open: Date.UTC(2025, 4, 1), close: Date.UTC(2026, 11, 9, 19), archived: false });
  const ticker = "KXFEDDECISION-26NOV-T14";
  return { ...m, ticker, event: "KXFEDDECISION-26NOV", raw: { ...m.raw, ticker, event_ticker: "KXFEDDECISION-26NOV" } };
})();
const SCAN_EVENT = worldEvent("KXFEDDECISION-26DEC", { status: "active", open: Date.UTC(2025, 5, 2, 14), close: Date.UTC(2026, 11, 9, 19), archived: false }, { bounded: true });

let ScanRun: typeof ScanRunClass;
let ScanResults: typeof ScanResultsComponent;
let getScanPrices: typeof GetScanPrices;
let loadCandidateKalshi: typeof LoadCandidateKalshi;
let tickerCandidates: typeof TickerCandidates;

beforeEach(async () => {
  vi.stubEnv("TWELVE_DATA_API_KEY", "test-key");
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  vi.resetModules();
  ({ ScanRun } = await import("../scan/scanRunner"));
  ({ ScanResults } = await import("../scan/ScanPage"));
  ({ getScanPrices } = await import("@/lib/scan/prices"));
  ({ loadCandidateKalshi } = await import("@/lib/scan/load"));
  ({ tickerCandidates } = await import("@/lib/scan/candidates"));
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

function stubScanRoutes() {
  stubWorld([SCAN_MARKET, MOVING_MARKET, ...SCAN_EVENT]);
  const world = globalThis.fetch;
  vi.stubGlobal("fetch", async (input: string | URL) => {
    const url = new URL(String(input), "http://localhost");
    if (url.pathname === SCAN_PRICES_PATH) {
      const span = parseSpan(url.searchParams, Date.now());
      if (!span.ok) return Response.json({ error: { code: "invalid_span", message: span.message } }, { status: 400 });
      const prices = await getScanPrices(url.searchParams.get("stock")!, span.value);
      return prices.ok ? Response.json(prices.data) : Response.json({ error: prices.error }, { status: 503 });
    }
    if (url.pathname === SCAN_CANDIDATE_PATH) {
      const r = await loadCandidateKalshi(url.searchParams.get("ticker")!, url.searchParams.get("kind") as "event" | "market", url.searchParams.get("long") === "1");
      return r.ok ? Response.json(r.data) : Response.json({ error: r.error }, { status: 422 });
    }
    return world(input);
  });
}

function finished(run: ScanRunClass): Promise<ScanSnapshot> {
  return new Promise((resolve) => {
    const check = () => {
      const s = run.getSnapshot();
      if (s.phase === "done" || s.phase === "failed") resolve(s);
    };
    run.subscribe(check);
    check();
  });
}

const CARD = /<section data-plain-english[\s\S]*?<\/section>/;

/** The summary's results text: the headline and the lead, less the fixed limits. */
const resultsText = (s: PlainSummary) => [s.headline, ...s.sections.filter((x) => x.id !== "limits").flatMap((x) => x.items)].join("\n");

async function scanned(choice: 30 | 90, resolution: "hourly" | "daily", { stock = "TLT", tickers = [SCAN_MARKET.ticker, "KXFEDDECISION-26DEC"] } = {}) {
  stubScanRoutes();
  const list = await tickerCandidates(tickers);
  if (!list.ok) throw new Error("expected candidates");
  const settings = { stock, choice, resolution, candidates: list.data.candidates };
  const run = new ScanRun(settings);
  const snap = await finished(run);
  expect(snap.phase).toBe("done");
  const html = renderToStaticMarkup(<ScanResults run={run} {...settings} />);
  run.dispose();
  return { html, snap, summary: scanPlainSummary({ ...settings, snap }) };
}

function expectSummaryMatchesCard(html: string, snap: ScanSnapshot, summary: PlainSummary) {
  const card = CARD.exec(html)?.[0];
  if (!card) throw new Error("expected the plain-English summary");
  // It's the results card's first part, and it's the builder's.
  expect(html.indexOf(card)).toBeLessThan(html.indexOf("Exploratory leads, not findings."));
  expect(textOf(card)).toBe(textOf(renderToStaticMarkup(<ScanPlainSummary summary={summary} />)));
  // Every number in it is on the card outside it, or declared and checked.
  const tested = snap.states.filter((s) => s.status === "done").length;
  const allowed = new Set([String(EVIDENCE.strongP), String(tested - 1)]);
  const missing = numbersNotOn(resultsText(summary), html.replace(CARD, ""));
  const derived = new Set(summary.derived);
  expect(missing.filter((n) => !derived.has(n)), "numbers neither on the card nor declared").toEqual([]);
  expect(missing.filter((n) => !allowed.has(n)), "declared numbers that don't match their source").toEqual([]);
}

describe("the scan's plain-English summary is its results card's", () => {
  it("for a market and an event at 90 days hourly", async () => {
    const { html, snap, summary } = await scanned(90, "hourly");
    expect(["pending", "none"]).not.toContain(summary.level);
    expect(summary.headline).toMatch(/^Out of 2 markets and events tested/);
    expectSummaryMatchesCard(html, snap, summary);
  });

  it("for a market and an event at 30 days daily", async () => {
    const { html, snap, summary } = await scanned(30, "daily");
    expectSummaryMatchesCard(html, snap, summary);
  });

  // The fake world's stocks don't move with Kalshi; these do, with one market (linkSymbol), at strengths
  // picked for the rating each reaches.
  const THREE = [MOVING_MARKET.ticker, SCAN_MARKET.ticker, "KXFEDDECISION-26DEC"];

  it("for a lead that doesn't survive the correction and has enough moves: Nothing stood out", async () => {
    linkSymbol("LINKU", MOVING_MARKET, 0.0015);
    const { html, snap, summary } = await scanned(90, "hourly", { stock: "LINKU", tickers: THREE });
    expect(summary.level).toBe("nothing_stood_out");
    expect(resultsText(summary)).toContain("doesn’t correct for the other 2 tests");
    expectSummaryMatchesCard(html, snap, summary);
  });

  it("for a lead that survives the correction but is fragile: Weak", async () => {
    linkSymbol("LINKW", MOVING_MARKET, 0.0005);
    const { html, snap, summary } = await scanned(90, "hourly", { stock: "LINKW", tickers: THREE });
    expect(summary.level).toBe("weak");
    expect(resultsText(summary)).toContain("It survives the correction, but it’s fragile.");
    expectSummaryMatchesCard(html, snap, summary);
  });

  it("for a lead that survives the correction with a corrected p-value under 0.005: Strong", async () => {
    linkSymbol("LINKA", MOVING_MARKET, 0.004);
    const { html, snap, summary } = await scanned(90, "hourly", { stock: "LINKA", tickers: THREE });
    expect(summary.level).toBe("strong");
    expect(resultsText(summary)).toContain("The strongest lead is “");
    expectSummaryMatchesCard(html, snap, summary);
  });
});
