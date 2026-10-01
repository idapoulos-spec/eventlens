// Hand-picked symbols for stock search. Twelve Data's symbol lists have no popularity or
// volume data, and some well-known names aren't in a company's listed name, so without this
// list "s&p 500" would rank Vanguard's ETF (the shortest name) above SPY, and "google" would
// find Google-themed ETFs but not GOOGL (listed as Alphabet Inc.).

export interface PopularSymbol {
  symbol: string;
  /** Other names people search for, matched like company names (case, spaces, and punctuation are ignored). */
  aliases?: readonly string[];
}

/**
 * Most popular first: among equally good matches, earlier entries rank higher. A symbol
 * missing from the downloaded lists is skipped. Keep it short; it isn't meant to be complete.
 */
export const POPULAR_SYMBOLS: readonly PopularSymbol[] = [
  { symbol: "SPY", aliases: ["s&p 500"] },
  { symbol: "QQQ", aliases: ["nasdaq 100", "nasdaq"] },
  { symbol: "NVDA" },
  { symbol: "AAPL" },
  { symbol: "MSFT" },
  { symbol: "AMZN" },
  { symbol: "GOOGL", aliases: ["google"] },
  { symbol: "GOOG", aliases: ["google"] },
  { symbol: "META", aliases: ["facebook"] },
  { symbol: "TSLA" },
  { symbol: "AVGO" },
  { symbol: "BRK.B" },
  { symbol: "JPM" },
  { symbol: "V" },
  { symbol: "NFLX" },
  { symbol: "AMD" },
  { symbol: "PLTR" },
  { symbol: "COIN" },
  { symbol: "DIA", aliases: ["dow jones"] },
  { symbol: "IWM", aliases: ["russell 2000"] },
  { symbol: "VOO" },
  { symbol: "VTI" },
  { symbol: "GLD", aliases: ["gold"] },
  { symbol: "SLV", aliases: ["silver"] },
  { symbol: "USO", aliases: ["oil", "crude oil"] },
  { symbol: "TLT" },
  { symbol: "IBIT", aliases: ["bitcoin"] },
  { symbol: "XOM" },
  { symbol: "WMT" },
  { symbol: "DIS" },
];
