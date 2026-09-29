// Styling and input attributes shared by StockSearch and KalshiSearch, so the two fields match.

export const labelTextClass = "mb-1.5 block text-xs font-medium text-ink-secondary";

// 16px text on phones keeps iOS Safari from zooming in when an input is focused.
export const inputClass =
  "w-full rounded-lg border border-border bg-surface-raised px-3 py-2.5 font-mono text-base uppercase text-ink placeholder:normal-case placeholder:text-ink-muted focus:border-series-kalshi focus:outline-none focus:ring-1 focus:ring-series-kalshi aria-invalid:border-down/60 sm:text-sm";

export const inputProps = {
  autoComplete: "off",
  autoCapitalize: "characters",
  autoCorrect: "off",
  spellCheck: false,
  enterKeyHint: "go",
} as const;
