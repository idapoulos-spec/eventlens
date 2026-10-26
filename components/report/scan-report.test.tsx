// A scan report's numbers are its results card's: a finished scan against the fake world (its
// routes answered by their loaders, as in scanRunner.test.ts), its card rendered as the page
// renders it, and its report built from the same snapshot.

import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { stubWorld, worldEvent, worldMarket } from "@/lib/history/test-world";
import { sectionText } from "@/lib/report/model";
import { parseSpan } from "@/lib/scan/api";
import { SCAN_CANDIDATE_PATH, SCAN_PRICES_PATH } from "@/lib/scan/types";
import type { getScanPrices as GetScanPrices } from "@/lib/scan/prices";
import type { loadCandidateKalshi as LoadCandidateKalshi } from "@/lib/scan/load";
import type { tickerCandidates as TickerCandidates } from "@/lib/scan/candidates";
import type { ScanRun as ScanRunClass, ScanSnapshot } from "../scan/scanRunner";
import type { ScanResults as ScanResultsComponent } from "../scan/ScanPage";
import { chanceLine, survivorsLine } from "../scan/text";
import type { scanReport as ScanReport } from "./scanReport";
import { numbersIn, numbersNotOn, tablesOf, textOf } from "./test-helpers";

vi.setConfig({ testTimeout: 120_000 });
vi.mock("server-only", () => ({}));
vi.mock("@/lib/store/db", () => ({ getAppSql: () => null }));

const NOW = Date.UTC(2026, 9, 7, 16, 40, 30);
const SCAN_MARKET = worldMarket("KXFEDDECISION-26OCT-H0", { status: "active", open: Date.UTC(2025, 4, 1), close: Date.UTC(2026, 9, 28, 18), archived: false });
const SCAN_EVENT = worldEvent("KXFEDDECISION-26DEC", { status: "active", open: Date.UTC(2025, 5, 2, 14), close: Date.UTC(2026, 11, 9, 19), archived: false }, { bounded: true });

let ScanRun: typeof ScanRunClass;
let ScanResults: typeof ScanResultsComponent;
let scanReport: typeof ScanReport;
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
  ({ scanReport } = await import("./scanReport"));
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
  stubWorld([SCAN_MARKET, ...SCAN_EVENT]);
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

describe("a scan report's numbers are its results card's", () => {
  it("for a market and an event, with an untested candidate, at 90 days hourly", async () => {
    stubScanRoutes();
    const list = await tickerCandidates([SCAN_MARKET.ticker, "KXFEDDECISION-26DEC"]);
    if (!list.ok) throw new Error("expected candidates");
    const missing = { ticker: "KXNOPE-26-X", kind: "market" as const, event: "KXNOPE-26", series: "KXNOPE", title: "Missing", label: null, picked: null, end: null, start: null, stored: false };
    const candidates = [...list.data.candidates, missing];
    const settings = { stock: "TLT", choice: 90 as const, resolution: "hourly" as const, candidates };
    const run = new ScanRun(settings);
    const snap = await finished(run);
    expect(snap.phase).toBe("done");
    const html = renderToStaticMarkup(<ScanResults run={run} {...settings} />);
    run.dispose();

    const report = scanReport({ ...settings, snap, asOf: null, selection: "a custom list", link: null, preparedBy: null, generatedAt: NOW, version: "test", commit: "test" });
    const page = textOf(html);
    const pageRows = tablesOf(html).find((t) => t.head[0] === "#" && t.head.includes("p (scan)"))!.rows;
    const results = report.sections.find((s) => s.id === "results")!;
    const table = results.blocks.find((b) => b.kind === "table" && b.id === "scan");
    if (!table || table.kind !== "table") throw new Error("expected the ranked table");

    // Two tested, ranked as on the page, cell for cell.
    expect(table.rows).toHaveLength(2);
    expect(pageRows).toHaveLength(2);
    table.rows.forEach((row, r) => {
      const pageRow = pageRows[r];
      expect(row[0]).toBe(pageRow[0]);
      expect(pageRow[1]).toContain(row[1]);
      expect(row.slice(3, 9), `row ${r}`).toEqual(pageRow.slice(2, 8));
      expect(numbersIn(row[9])).toEqual(numbersIn(pageRow[8]));
      expect(row[10]).toBe(pageRow[9]);
    });

    // The banner says what the page's does, and the untested candidate is listed with its reason.
    const tested = snap.states.filter((s) => s.status === "done");
    const under = tested.filter((s) => s.status === "done" && (s.test.primary?.p ?? 1) < 0.05).length;
    const banner = results.blocks.find((b) => b.kind === "callout");
    if (!banner || banner.kind !== "callout") throw new Error("expected the banner");
    expect(banner.title).toBe("Exploratory leads, not findings.");
    expect(banner.items[0]).toBe(chanceLine(under, tested.length));
    expect(banner.items[1]).toBe(survivorsLine(snap.corrections.filter((c) => c?.survivesHolm).length, snap.corrections.filter((c) => c?.survivesBh).length));
    for (const item of banner.items) expect(page).toContain(item);
    expect(sectionText(results)).toContain("KXNOPE-26-X: ");

    // Every number outside the table is on the page too.
    expect(numbersNotOn(sectionText({ ...results, blocks: results.blocks.filter((b) => b.kind !== "table") }), page)).toEqual([]);
  });
});
