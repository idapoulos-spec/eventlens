import type { SignalLevel } from "@/lib/analytics/signal";
import type { BottomLineLevel } from "./summary";

/**
 * The evidence badge's looks, shared by the card's badge and the signal's level: an ink ramp with no
 * hue, so no level reads as a go or a stop. Weight and border style carry the level, and it's always
 * written out. Every text here is at least 9.2:1 on the card (README, "The bottom line").
 */
export const BADGE: Record<Exclude<BottomLineLevel | SignalLevel, "none">, string> = {
  strong: "bg-ink text-page",
  moderate: "bg-[var(--axis)] text-ink",
  weak: "border border-ink-muted text-ink-secondary",
  no_clear_link: "border border-border text-ink-secondary",
  nothing_stood_out: "border border-border text-ink-secondary",
  no_clear_lead: "border border-border text-ink-secondary",
  not_enough_data: "border border-dashed border-ink-muted text-ink-secondary",
  pending: "border border-dotted border-ink-muted text-ink-secondary",
};
