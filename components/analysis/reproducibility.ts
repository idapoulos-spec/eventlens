// What a frozen link (one with an as-of time) gives again later, and what can still change. Plain
// text, so the page's explainer and the reports say exactly the same.

/** Given the same data, these come out the same every time. */
export const REPRODUCED: string[] = [
  "The windows and every setting: the link carries them all, and the windows end at its as-of time (or at the market’s close, if it had closed by then).",
  "The statistics: every bootstrap and simulation starts from a fixed seed, so the same data gives the same estimates, intervals, p-values, and detectable sizes.",
  "Kalshi candles read from EventLens’s data store, which don’t change once collected.",
];

/** These can still change the numbers. */
export const MAY_DIFFER: string[] = [
  "Kalshi candles after the data store’s stored-through time are fetched from Kalshi again on each load (from its archive once a market is archived), and markets the store doesn’t collect are fetched entirely live. Kalshi’s past candles aren’t expected to change, but nothing guarantees it.",
  "Stock and benchmark prices aren’t stored, so they’re downloaded from Twelve Data again on each load. A correction, a late trade in a bar frozen minutes after it closed, a later split (which rescales the adjusted daily prices: returns are unchanged in principle, but their last digits can move), or a ticker change can change the numbers.",
  "In the minutes after the 4 PM close, a live page counts that day’s session only once Twelve Data reports the market closed; a frozen link always counts it, so a link frozen then can differ by that one session.",
  "Kalshi’s market details (title, YES label, status) are read again on each load.",
  "The statistics run in the browser. Another browser’s math library can differ in the last digits, which almost never changes a figure as shown (a bootstrap p-value on an exact tie could move by one draw).",
  "Only Research (and a whole event’s panel) is frozen: the Kalshi market panel, the stock panel, and the 7-day charts always show the latest data.",
];
