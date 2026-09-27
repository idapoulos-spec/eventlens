// Stock symbols: letters/digits with optional class suffix, e.g. NVDA, BRK.B, BF-B.
const STOCK_TICKER = /^[A-Z][A-Z0-9]{0,6}([.-][A-Z0-9]{1,3})?$/;
// Kalshi market tickers: uppercase segments separated by '-', e.g. KXFED-26DEC-T4.00.
const KALSHI_TICKER = /^[A-Z0-9][A-Z0-9._-]{1,99}$/;

export type Validated = { ok: true; value: string } | { ok: false; message: string };

export function validateStockTicker(input: string | null | undefined): Validated {
  const value = (input ?? "").trim().toUpperCase();
  if (!value) return { ok: false, message: "Enter a stock ticker, e.g. NVDA." };
  if (!STOCK_TICKER.test(value)) return { ok: false, message: `"${value}" is not a valid stock ticker.` };
  return { ok: true, value };
}

export function validateKalshiTicker(input: string | null | undefined): Validated {
  const value = (input ?? "").trim().toUpperCase();
  if (!value) return { ok: false, message: "Enter a Kalshi market ticker." };
  if (!KALSHI_TICKER.test(value)) return { ok: false, message: `"${value}" is not a valid Kalshi market ticker.` };
  return { ok: true, value };
}
