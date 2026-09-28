const DASH = "—";

export function formatPercent(value: number | null, digits = 1): string {
  return value === null ? DASH : `${value.toFixed(digits)}%`;
}

/** Probability in [0, 1] shown as a percentage. */
export function formatProbability(p: number | null, digits = 1): string {
  return p === null ? DASH : `${(p * 100).toFixed(digits)}%`;
}

/** Kalshi contract price in dollars (0–1) shown in cents, e.g. 0.42 -> "42¢". */
export function formatCents(price: number | null): string {
  if (price === null) return DASH;
  const cents = price * 100;
  return `${Number.isInteger(cents) ? cents.toFixed(0) : cents.toFixed(1)}¢`;
}

export function formatSigned(value: number | null, digits = 2, suffix = ""): string {
  if (value === null) return DASH;
  const sign = value > 0 ? "+" : value < 0 ? "−" : "";
  return `${sign}${Math.abs(value).toFixed(digits)}${suffix}`;
}

export function formatCurrency(value: number | null, currency = "USD"): string {
  if (value === null) return DASH;
  return new Intl.NumberFormat("en-US", { style: "currency", currency, maximumFractionDigits: 2 }).format(value);
}

export function formatCompact(value: number | null): string {
  if (value === null) return DASH;
  return new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 2 }).format(value);
}

/** A wait time in words, e.g. 45 -> "45 seconds", 600 -> "10 minutes". */
export function formatWait(seconds: number): string {
  if (seconds < 90) return `${seconds} second${seconds === 1 ? "" : "s"}`;
  return `${Math.ceil(seconds / 60)} minutes`;
}

export function formatDateTime(ms: number): string {
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short",
  }).format(ms);
}

export function formatDate(ms: number): string {
  return new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric" }).format(ms);
}
