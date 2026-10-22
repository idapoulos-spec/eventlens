// The scan page's runner end to end, against the fake world the golden pins use: the scan's routes
// are answered by their loaders (the routes add only sign-in, validation, and limits), and every
// result must be the one its page would show.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ScanTest } from "@/lib/analytics/scan";
import { stubWorld, worldEvent, worldMarket } from "@/lib/history/test-world";
import type { getScanPrices as GetScanPrices } from "@/lib/scan/prices";
import type { loadCandidateKalshi as LoadCandidateKalshi } from "@/lib/scan/load";
import type { tickerCandidates as TickerCandidates } from "@/lib/scan/candidates";
import { parseSpan } from "@/lib/scan/api";
import { SCAN_CANDIDATE_PATH, SCAN_PRICES_PATH, type ScanCandidate } from "@/lib/scan/types";
import type { ScanRun as ScanRunClass, ScanSnapshot } from "./scanRunner";

vi.setConfig({ testTimeout: 60_000 });
vi.mock("server-only", () => ({}));
vi.mock("@/lib/store/db", () => ({ getAppSql: () => null }));

const NOW = Date.UTC(2026, 9, 7, 16, 40, 30);
// A market of another meeting than the event, so the event's outcomes are its own five.
const LIVE_MARKET = worldMarket("KXFEDDECISION-26OCT-H0", { status: "active", open: Date.UTC(2025, 4, 1), close: Date.UTC(2026, 9, 28, 18), archived: false });
const LIVE_EVENT = worldEvent("KXFEDDECISION-26DEC", { status: "active", open: Date.UTC(2025, 5, 2, 14), close: Date.UTC(2026, 11, 9, 19), archived: false }, { bounded: true });

let ScanRun: typeof ScanRunClass;
let getScanPrices: typeof GetScanPrices;
let loadCandidateKalshi: typeof LoadCandidateKalshi;
let tickerCandidates: typeof TickerCandidates;

beforeEach(async () => {
  vi.stubEnv("TWELVE_DATA_API_KEY", "test-key");
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  vi.resetModules();
  ({ ScanRun } = await import("./scanRunner"));
  ({ getScanPrices } = await import("@/lib/scan/prices"));
  ({ loadCandidateKalshi } = await import("@/lib/scan/load"));
  ({ tickerCandidates } = await import("@/lib/scan/candidates"));
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

/** The world's upstreams, with the scan's two routes answered by their loaders. */
function stubScanRoutes() {
  stubWorld([LIVE_MARKET, ...LIVE_EVENT]);
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
      return r.ok ? Response.json(r.data) : Response.json({ error: r.error }, { status: r.error.code === "not_found" ? 404 : 422 });
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

describe("ScanRun", () => {
  it("tests every candidate as its page would, corrects across them, and runs leave-one-out for the top ones", async () => {
    stubScanRoutes();
    const list = await tickerCandidates([LIVE_MARKET.ticker, "KXFEDDECISION-26DEC"]);
    if (!list.ok) throw new Error("expected candidates");
    const run = new ScanRun({ stock: "TLT", choice: 90, resolution: "hourly", candidates: list.data.candidates });
    const snap = await finished(run);
    expect(snap.phase).toBe("done");
    expect(snap.states.map((s) => (s.status === "untested" ? s.reason : s.status))).toEqual(["done", "done"]);
    expect(snap.prices?.requests).toBe(4);

    const tests = snap.states.map((s) => (s.status === "done" ? s.test : null)) as ScanTest[];
    // Final corrections over both, ranked by p.
    expect(snap.corrections.every((c) => c !== null && c.holm !== null)).toBe(true);
    expect(snap.order).toHaveLength(2);
    expect(tests[snap.order[0]].p!).toBeLessThanOrEqual(tests[snap.order[1]].p!);
    // Leave-one-out ran for both (the top five).
    for (const s of snap.states) expect(s.status === "done" && typeof s.loo === "object" && s.loo !== null).toBe(true);
    expect(snap.timings.longestSlice).toBeGreaterThan(0);
    run.dispose();
  });

  it("waits out Twelve Data's minute once when the prices are turned away, then goes on", async () => {
    stubScanRoutes();
    const routes = globalThis.fetch;
    let turnedAway = 0;
    vi.stubGlobal("fetch", async (input: string | URL) => {
      if (String(input).startsWith(SCAN_PRICES_PATH) && turnedAway === 0) {
        turnedAway++;
        return Response.json({ error: { code: "upstream_rate_limited", message: "Twelve Data rate limit reached." } }, { status: 429, headers: { "Retry-After": "1" } });
      }
      return routes(input);
    });
    const list = await tickerCandidates([LIVE_MARKET.ticker]);
    if (!list.ok) throw new Error("expected candidates");
    const run = new ScanRun({ stock: "TLT", choice: 30, resolution: "daily", candidates: list.data.candidates });
    let waited = false;
    run.subscribe(() => {
      if (run.getSnapshot().waitingUntil !== null) waited = true;
    });
    const snap = await finished(run);
    expect(turnedAway).toBe(1);
    expect(waited).toBe(true);
    expect(snap.phase).toBe("done");
    expect(snap.waitingUntil).toBeNull();
    run.dispose();
  });

  it("finishes when no candidate can be tested, with each one's reason", async () => {
    stubScanRoutes();
    const missing: ScanCandidate = { ticker: "KXNOPE-26-X", kind: "market", event: "KXNOPE-26", series: "KXNOPE", title: "Missing", label: null, picked: null, end: null, start: null, stored: false };
    const run = new ScanRun({ stock: "TLT", choice: 30, resolution: "daily", candidates: [missing] });
    const snap = await finished(run);
    expect(snap.phase).toBe("done");
    expect(snap.states[0]).toMatchObject({ status: "untested" });
    expect(snap.corrections).toEqual([{ holm: null, bh: null, survivesHolm: false, survivesBh: false }]);
    run.dispose();
  });
});
