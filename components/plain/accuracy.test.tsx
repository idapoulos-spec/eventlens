// The plain-English card's numbers are its page's. The page is rendered as the server renders it,
// from the fake world through the real loaders and components, with its background parts (the
// detectable size and the leave-one-out check) run at once. The card on that page must say exactly
// what the summary builder says for the same rows and settings, and every number in it must be
// printed elsewhere on the page, outside the card, unless the builder declares it as derived: a size
// rescaled to 10 pp or 25 bp (recomputed here, and consistent with the page's per-unit figure), a
// lag's count of hours or days (the page prints that lag), or a constant of the rating's own rules
// and simulations. The fake world's stocks don't move with Kalshi, so the rated cases also use
// symbols linked to one market (linkSymbol), picked for the rule each reaches. The report built from
// the same state opens with the card's text, part by part, and ends with its glossary. 180D, 1Y, and All can't be rendered statically (their rows load in an effect, as
// for reports); summary.test.ts covers the builder on long-window results.

import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EVIDENCE } from "@/lib/analytics/evidence";
import type { PanelMessage } from "@/lib/analytics/panel-jobs";
import { formatSigned } from "@/lib/format";
import { linkSymbol, stubWorld, worldEvent, worldMarket } from "@/lib/history/test-world";
import { formatLag } from "../charts/LeadLagChart";
import { analysisReport, type AnalysisReportInput } from "../report/analysisReport";
import { eventPage, marketPage, reportInputFor, type Loaded, type PageDeps } from "../report/test-build";
import { numbersIn, numbersNotOn, textOf } from "../report/test-helpers";
import { GLOSSARY } from "./glossary";
import { PlainEnglishCard } from "./PlainEnglishCard";
import { RATING_METHOD_NUMBERS, plainSummary, type PlainInput, type PlainSummary } from "./summary";
import { cardGlossary, cardParts, plainText, reportParts } from "./test-helpers";

vi.setConfig({ testTimeout: 120_000 });
vi.mock("server-only", () => ({}));
vi.mock("@/lib/store/db", () => ({ getAppSql: () => null }));
// The panel's background parts, run at once, so the server's render shows them.
vi.mock("@/components/research/panelJobs", async () => {
  const jobs = await import("@/lib/analytics/panel-jobs");
  const partId = (kind: string, key: string) => `${kind}:${key}`;
  return {
    partId,
    useDelayed: () => false,
    usePanelJobs: (list: Parameters<typeof jobs.runJob>[1][]) => {
      const parts = new Map<string, PanelMessage>();
      const run = jobs.panelRunner();
      for (const job of list) jobs.runJob(run, job, (m) => parts.set(partId(m.kind, m.key), m));
      return parts;
    },
  };
});

const NOW = Date.UTC(2026, 9, 7, 16, 40, 30);
const LIVE_MARKET = worldMarket("KXFEDDECISION-26DEC-H0", { status: "active", open: Date.UTC(2025, 4, 1), close: Date.UTC(2026, 11, 9, 19), archived: false });
/** A market whose quotes move often enough for a rating (an effective 26 moves at 90 days). */
const MOVING_MARKET = worldMarket("KXFEDDECISION-26DEC-T14", { status: "active", open: Date.UTC(2025, 4, 1), close: Date.UTC(2026, 11, 9, 19), archived: false });
const LONG_EVENT = worldEvent("KXFEDDECISION-26DEC", { status: "active", open: Date.UTC(2025, 5, 2, 14), close: Date.UTC(2026, 11, 9, 19), archived: false }, { bounded: true });

let deps: PageDeps;

beforeEach(async () => {
  vi.stubEnv("TWELVE_DATA_API_KEY", "test-key");
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  vi.resetModules();
  deps = {
    loadAnalysis: (await import("@/lib/history/analysis")).loadAnalysis,
    loadEventAnalysis: (await import("@/lib/expected/load")).loadEventAnalysis,
    Research: (await import("../Research")).Research,
    EventResearch: (await import("../event/EventDashboard")).EventResearch,
  };
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

const CARD = /<section data-plain-english[\s\S]*?<\/section>/;

/** The card's markup on the page, and the page without it. */
function split(html: string): { card: string; rest: string } {
  const card = CARD.exec(html)?.[0];
  if (!card) throw new Error("expected the plain-English card");
  return { card, rest: html.replace(CARD, "") };
}

/** The summary of the view's results, built from what the panel holds. */
function summaryFor(page: Loaded, stock: string, kalshi: string, view: Parameters<typeof reportInputFor>[3]): { input: AnalysisReportInput; summary: PlainSummary } {
  const input = reportInputFor(page, stock, kalshi, view);
  return { input, summary: plainSummary(input) };
}

/** The card's results text: everything but the fixed limits, the method notes, and the glossary. */
const resultsText = (s: PlainSummary) => [s.headline, ...s.sections.filter((x) => x.id !== "limits").flatMap((x) => x.items)].join("\n");

/** The derived numbers this view's summary may hold, each worked out from its source; throws when one doesn't match the page. */
function allowedDerived(input: PlainInput, rest: string): Set<string> {
  const page = textOf(rest);
  const allowed = new Set<string>([String(EVIDENCE.strongP), EVIDENCE.maxDetectable.toFixed(2), ...RATING_METHOD_NUMBERS]);
  // A size for 10 pp (from 40% to 50%) or 25 bp: the page's per-unit coefficient, rescaled.
  const fit = input.results.market?.kalshi;
  if (fit) {
    const scale = input.variable.kind === "probability" ? 10 : input.variable.unit === "bp" ? 25 : 1;
    allowed.add(String(scale));
    if (input.variable.kind === "probability") ["40%", "50%"].forEach((n) => allowed.add(n));
    for (const v of [fit.coef, ...(fit.test.ci ?? [])]) {
      const perUnit = formatSigned(v, 3, "%");
      expect(page, "the per-unit size the card rescales").toContain(perUnit);
      const card = formatSigned(v * scale, 2, "%");
      const fromPage = Number(perUnit.replace(/[−%]/g, (c) => (c === "−" ? "-" : "")));
      expect(Math.abs(Number(card.replace(/[−%]/g, (c) => (c === "−" ? "-" : ""))) - fromPage * scale)).toBeLessThanOrEqual(0.0005 * scale + 0.005 + 1e-9);
      allowed.add(card.replace(/−/g, "-"));
    }
  }
  // A lag's count of hours or days, for a lag the page prints.
  const unit = input.resolution === "hourly" ? "h" : "d";
  for (const l of input.results.view.lags) if (l.lag !== 0 && page.includes(formatLag(l.lag, unit))) allowed.add(String(Math.abs(l.lag)));
  return allowed;
}

/** Glossary markers sit only in text: never inside a <summary>, an <option>, or another button. */
function expectMarkersInText(html: string) {
  expect(html).toContain("data-term");
  for (const tag of ["summary", "option", "button"]) {
    for (const [inner] of html.matchAll(new RegExp(`<${tag}\\b[^>]*>[\\s\\S]*?</${tag}>`, "g"))) expect(inner, tag).not.toContain("data-term");
  }
}

/** The report from the same state opens with the card's text and ends with its glossary. */
function expectReportMatchesCard(html: string, input: AnalysisReportInput) {
  const { card } = split(html);
  const report = analysisReport(input);
  const first = report.sections[0];
  expect(first.id).toBe("plain-english");
  const parts = reportParts(first);
  const method = parts.indexOf("How the rating works");
  expect(method).toBeGreaterThan(4);
  expect(parts.slice(0, method)).toEqual(cardParts(card));
  const notes = /<details[\s\S]*?<\/details>/.exec(card)![0];
  expect(parts.slice(method + 1)).toEqual([...notes.matchAll(/<p\b[^>]*>([\s\S]*?)<\/p>/g)].map((m) => plainText(m[1])));
  const terms = report.sections.at(-1)!;
  expect(terms.id).toBe("terms");
  const rows = terms.blocks[0].kind === "facts" ? terms.blocks[0].rows : [];
  expect(rows.map(([k, v]) => `${k}: ${v}`)).toEqual(cardGlossary(card));
  expect(rows).toHaveLength(GLOSSARY.length);
}

/** The card says what the builder says, and every number in it is the page's or a checked derived one. */
function expectCardMatchesPage(html: string, input: AnalysisReportInput, summary: PlainSummary) {
  expectMarkersInText(html);
  expectReportMatchesCard(html, input);
  const { card, rest } = split(html);
  expect(textOf(card)).toBe(textOf(renderToStaticMarkup(<PlainEnglishCard summary={summary} />)));
  const missing = numbersNotOn(resultsText(summary), rest);
  const derived = new Set(summary.derived.map((n) => n.replace(/−/g, "-")));
  expect(missing.filter((n) => !derived.has(n)), "numbers neither on the page nor declared").toEqual([]);
  const allowed = allowedDerived(input, rest);
  expect(missing.filter((n) => !allowed.has(n)), "declared numbers that don't match their source").toEqual([]);
}

describe("the plain-English card's numbers are its page's", () => {
  it("for a single market, at 90 days hourly, market-adjusted (the default)", async () => {
    stubWorld([LIVE_MARKET]);
    const page = await marketPage(deps, "NVDA", LIVE_MARKET.ticker, { window: null, resolution: null });
    const { input, summary } = summaryFor(page, "NVDA", LIVE_MARKET.ticker, { choice: 90, resolution: "hourly" });
    // Rated: the background parts it waits for are in.
    expect(["pending", "none"]).not.toContain(summary.level);
    expectCardMatchesPage(page.html, input, summary);
  });

  it("for a single market at 30 days daily, raw returns, and another jump size", async () => {
    stubWorld([LIVE_MARKET]);
    const page = await marketPage(deps, "NVDA", LIVE_MARKET.ticker, { window: 30, resolution: "daily", returns: "raw", jump: 5 });
    const { input, summary } = summaryFor(page, "NVDA", LIVE_MARKET.ticker, { choice: 30, resolution: "daily", returns: "raw", jump: 5 });
    expect(resultsText(summary)).toContain("raw returns");
    expectCardMatchesPage(page.html, input, summary);
  });

  it("for a single market at 7 days, which holds too few trading days for a rating", async () => {
    stubWorld([LIVE_MARKET]);
    const page = await marketPage(deps, "NVDA", LIVE_MARKET.ticker, { window: 7, resolution: null });
    const { input, summary } = summaryFor(page, "NVDA", LIVE_MARKET.ticker, { choice: 7, resolution: "hourly" });
    expect(summary.level).toBe("not_enough_data");
    expectCardMatchesPage(page.html, input, summary);
  });

  it("for a single market whose benchmark is the stock itself (no rating)", async () => {
    stubWorld([LIVE_MARKET]);
    const page = await marketPage(deps, "NVDA", LIVE_MARKET.ticker, { window: 7, resolution: null, benchmark: "NVDA" });
    const { input, summary } = summaryFor(page, "NVDA", LIVE_MARKET.ticker, { choice: 7, resolution: "hourly", benchmark: "NVDA" });
    expect(summary.level).toBe("none");
    expect(summary.headline).toContain("NVDA is the benchmark itself");
    expectCardMatchesPage(page.html, input, summary);
  });

  it("for a whole event's expected value, at 90 days hourly", async () => {
    stubWorld(LONG_EVENT);
    const page = await eventPage(deps, "TLT", "KXFEDDECISION-26DEC", { window: null, resolution: null });
    const { input, summary } = summaryFor(page, "TLT", "KXFEDDECISION-26DEC", { choice: 90, resolution: "hourly" });
    expect(["pending", "none"]).not.toContain(summary.level);
    expect(resultsText(summary)).toContain("25-basis-point");
    expectCardMatchesPage(page.html, input, summary);
  });

  it("for a whole event's expected value, at 30 days daily", async () => {
    stubWorld(LONG_EVENT);
    const page = await eventPage(deps, "TLT", "KXFEDDECISION-26DEC", { window: 30, resolution: "daily" });
    const { input, summary } = summaryFor(page, "TLT", "KXFEDDECISION-26DEC", { choice: 30, resolution: "daily" });
    expectCardMatchesPage(page.html, input, summary);
  });

  it("for a link in the same hour, rated Strong at 90 days hourly, with the 90-day simulation note", async () => {
    linkSymbol("LINKA", MOVING_MARKET, 0.004);
    stubWorld([MOVING_MARKET]);
    const page = await marketPage(deps, "LINKA", MOVING_MARKET.ticker, { window: null, resolution: null });
    const { input, summary } = summaryFor(page, "LINKA", MOVING_MARKET.ticker, { choice: 90, resolution: "hourly" });
    expect(summary.level).toBe("strong");
    expect(resultsText(summary)).toContain("rated Strong 1.8% (9 of 500) of the time");
    expectCardMatchesPage(page.html, input, summary);
  });

  it("for the same link, rated Moderate at 30 days hourly", async () => {
    linkSymbol("LINKA", MOVING_MARKET, 0.004);
    stubWorld([MOVING_MARKET]);
    const page = await marketPage(deps, "LINKA", MOVING_MARKET.ticker, { window: 30, resolution: null });
    const { input, summary } = summaryFor(page, "LINKA", MOVING_MARKET.ticker, { choice: 30, resolution: "hourly" });
    expect(summary.level).toBe("moderate");
    expectCardMatchesPage(page.html, input, summary);
  });

  it("for the same link at 90 days daily, which wasn't simulated", async () => {
    linkSymbol("LINKA", MOVING_MARKET, 0.004);
    stubWorld([MOVING_MARKET]);
    const page = await marketPage(deps, "LINKA", MOVING_MARKET.ticker, { window: null, resolution: "daily" });
    const { input, summary } = summaryFor(page, "LINKA", MOVING_MARKET.ticker, { choice: 90, resolution: "daily" });
    expect(summary.level).toBe("strong");
    expect(resultsText(summary)).toContain("this setting wasn’t simulated");
    expectCardMatchesPage(page.html, input, summary);
  });

  it("for a link that a left-out trading day changes, rated Weak at 30 days hourly", async () => {
    linkSymbol("LINKC", MOVING_MARKET, 0.004);
    stubWorld([MOVING_MARKET]);
    const page = await marketPage(deps, "LINKC", MOVING_MARKET.ticker, { window: 30, resolution: null });
    const { input, summary } = summaryFor(page, "LINKC", MOVING_MARKET.ticker, { choice: 30, resolution: "hourly" });
    expect(summary.level).toBe("weak");
    expect(input.leaveOneOut?.flips).toBeGreaterThan(0);
    expectCardMatchesPage(page.html, input, summary);
  });

  it("for no link in the same hour but a passing one an hour later, rated No clear link", async () => {
    linkSymbol("LAGGD", MOVING_MARKET, 0.006, 1);
    stubWorld([MOVING_MARKET]);
    const page = await marketPage(deps, "LAGGD", MOVING_MARKET.ticker, { window: null, resolution: null });
    const { input, summary } = summaryFor(page, "LAGGD", MOVING_MARKET.ticker, { choice: 90, resolution: "hourly" });
    expect(summary.level).toBe("no_clear_link");
    expect(resultsText(summary)).toContain("LAGGD tended to move 1 hour after Kalshi did");
    expectCardMatchesPage(page.html, input, summary);
  });

  it("for lags passing both ways", async () => {
    linkSymbol("LAGGE", MOVING_MARKET, 0.006, 1);
    stubWorld([MOVING_MARKET]);
    const page = await marketPage(deps, "LAGGE", MOVING_MARKET.ticker, { window: null, resolution: null });
    const { input, summary } = summaryFor(page, "LAGGE", MOVING_MARKET.ticker, { choice: 90, resolution: "hourly" });
    expect(resultsText(summary)).toMatch(/Also, LAGGE moved first: Kalshi tended to move 1 hour after LAGGE did/);
    expectCardMatchesPage(page.html, input, summary);
  });

  it("would catch a card number that differs from the page's, or a declared one that doesn't match its source", async () => {
    stubWorld([LIVE_MARKET]);
    const page = await marketPage(deps, "NVDA", LIVE_MARKET.ticker, { window: null, resolution: null });
    const { input, summary } = summaryFor(page, "NVDA", LIVE_MARKET.ticker, { choice: 90, resolution: "hourly" });
    const { rest } = split(page.html);
    // A changed count is on neither the page nor the declared list.
    const trust = summary.sections.find((s) => s.id === "trust")!;
    const changed = trust.items.map((t) => t.replace(/^Based on [\d,]+/, "Based on 123,456"));
    expect(changed).not.toEqual(trust.items);
    expect(numbersNotOn(changed.join("\n"), rest)).toContain("123,456");
    // A size declared but not the page's coefficient rescaled is caught by its source check.
    const allowed = allowedDerived(input, rest);
    expect(allowed.has("+9.99%")).toBe(false);
    // And the card on the page is the builder's, so a changed headline wouldn't match it.
    expect(() => expectCardMatchesPage(page.html, input, { ...summary, headline: `${summary.headline} Extra 7.` })).toThrow();
  });

  it("finds numbers as the report check does (signs and percents kept)", () => {
    expect(numbersIn("a −0.12% move, 1,712 trading hours, p-value 0.034")).toEqual(["-0.12%", "1,712", "0.034"]);
  });
});
