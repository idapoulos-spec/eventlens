import { describe, expect, it } from "vitest";
import { DEFAULT_SCAN, frozenScanHref, parseScanLink, scanHref, type ScanLink } from "./link";

const NOW = Date.UTC(2026, 9, 25, 16);
const read = (href: string) => {
  const params = new URL(href, "http://localhost").searchParams;
  return parseScanLink((name) => params.get(name), NOW);
};

describe("scanHref and parseScanLink", () => {
  it("leave every default out, so the home page's link to a stock's scan is unchanged", () => {
    expect(scanHref(DEFAULT_SCAN)).toBe("/scan");
    expect(scanHref({ ...DEFAULT_SCAN, stock: "TLT" })).toBe(`/scan?${new URLSearchParams({ stock: "TLT" })}`);
    expect(read("/scan?stock=TLT").link).toEqual({ ...DEFAULT_SCAN, stock: "TLT" });
  });

  it("carry every setting of the form, and read back the same", () => {
    const links: ScanLink[] = [
      { ...DEFAULT_SCAN, stock: "TLT", series: "KXCPI", settled: true, window: 365, resolution: "daily", asOf: Date.UTC(2026, 9, 7, 18, 2, 10, 345) },
      { ...DEFAULT_SCAN, stock: "NVDA", source: "stored", series: "" },
      { ...DEFAULT_SCAN, stock: "NVDA", source: "stored" },
      { ...DEFAULT_SCAN, stock: "TLT", source: "tickers", tickers: "KXFEDDECISION-26DEC\nKXFEDDECISION-26OCT-H0", window: "all" },
    ];
    for (const link of links) expect(read(scanHref(link)).link, scanHref(link)).toEqual(link);
  });

  it("falls back to each default for a setting it can't read, but rejects an as-of time it can't", () => {
    const { link, asOf } = read("/scan?stock=not+a+ticker&source=web&window=8&res=weekly&tickers=a%20b");
    expect(link).toEqual(DEFAULT_SCAN);
    // A custom list is read as the candidates route reads it: upper case, one per line, each listed once.
    expect(read("/scan?source=tickers&tickers=kxfeddecision-26dec%20KXFEDDECISION-26DEC,kxfeddecision-26oct-h0").link.tickers).toBe("KXFEDDECISION-26DEC\nKXFEDDECISION-26OCT-H0");
    expect(read("/scan?window=7&res=daily").link.resolution).toBe("hourly");
    expect(asOf).toEqual({ ok: true, data: null });
    expect(read("/scan?asof=2026-10-07").asOf.ok).toBe(false);
    expect(read("/scan?asof=2099-01-01T00:00Z").asOf.ok).toBe(false);
  });
});

describe("frozenScanHref", () => {
  it("names the candidates tested, as a custom list, with the window, resolution, and as-of time", () => {
    const href = frozenScanHref({
      stock: "TLT",
      candidates: [{ ticker: "KXFEDDECISION-26DEC" }, { ticker: "KXCPI-26NOV-T0.3" }],
      window: 30,
      resolution: "daily",
      asOf: Date.UTC(2026, 9, 7, 16, 40, 30),
    });
    expect(href).toBe("/scan?stock=TLT&source=tickers&tickers=KXFEDDECISION-26DEC%2CKXCPI-26NOV-T0.3&window=30&res=daily&asof=2026-10-07T16%3A40%3A30Z");
    expect(read(href).link).toMatchObject({ source: "tickers", tickers: "KXFEDDECISION-26DEC\nKXCPI-26NOV-T0.3", asOf: Date.UTC(2026, 9, 7, 16, 40, 30) });
  });
});
