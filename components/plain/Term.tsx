"use client";

import { useEffect, useLayoutEffect, useReducer, useRef, type ReactNode } from "react";
import { GLOSSARY, GLOSSARY_BY_ID, type GlossaryEntry, type TermId } from "./glossary";

// A glossary term marked in the text: a button holding the term, and a live region that holds its
// definition only while it's open, so a screen reader announces it then (the toggletip pattern).
// Hover or focus shows it; a tap or click keeps it open until a second tap, Escape, or a tap or focus
// elsewhere. Closed, the markup is exactly
//   <span data-term=""><button …>TERM</button><span role="status" …></span></span>
// which the page pins (page-pins.test.tsx) read back as TERM, so the cards they cover stay the same.

export interface TermState {
  open: boolean;
  /** Opened by a tap or click: stays open when the pointer leaves. */
  pinned: boolean;
}

export type TermAction = "hover" | "unhover" | "focus" | "blur" | "press" | "escape" | "outside";

export const TERM_CLOSED: TermState = { open: false, pinned: false };

/** How a term's definition opens and closes. Pure, so it's tested without a DOM (term.test.ts). */
export function termReducer(state: TermState, action: TermAction): TermState {
  switch (action) {
    case "hover":
    case "focus":
      return state.open ? state : { open: true, pinned: false };
    case "unhover":
      return state.pinned ? state : TERM_CLOSED;
    case "press":
      // A tap focuses the button first (which opens it), then presses it: that keeps it open.
      return state.pinned ? TERM_CLOSED : { open: true, pinned: true };
    case "blur":
    case "escape":
    case "outside":
      return TERM_CLOSED;
  }
}

/** How far (px) to move a popover left so its right edge stays `gutter` inside the viewport. */
export function popoverShift(left: number, width: number, viewport: number, gutter = 8): number {
  const over = left + width - (viewport - gutter);
  return over > 0 ? Math.min(over, Math.max(0, left - gutter)) : 0;
}

const LETTER = /\p{L}/u;

/** Where each still-unmarked term first appears in `text` as a whole word: its earliest phrase. */
function hitsIn(text: string, entries: GlossaryEntry[], used: Set<TermId>): { at: number; end: number; id: TermId }[] {
  const hits: { at: number; end: number; id: TermId }[] = [];
  for (const e of entries) {
    if (used.has(e.id)) continue;
    let best: { at: number; end: number } | null = null;
    for (const phrase of e.phrases) {
      for (let at = text.indexOf(phrase); at >= 0; at = text.indexOf(phrase, at + 1)) {
        const end = at + phrase.length;
        if (LETTER.test(text[at - 1] ?? "") || LETTER.test(text[end] ?? "")) continue;
        if (best === null || at < best.at) best = { at, end };
        break;
      }
    }
    if (best) hits.push({ ...best, id: e.id });
  }
  return hits.sort((a, b) => a.at - b.at);
}

/**
 * The texts of one card, in reading order, with the first use of each glossary term marked. Pure:
 * the whole card's marks are worked out at once, so a re-render marks the same places.
 */
export function markTerms(texts: string[], entries: GlossaryEntry[] = GLOSSARY): ReactNode[] {
  const used = new Set<TermId>();
  return texts.map((text) => {
    const parts: ReactNode[] = [];
    let pos = 0;
    for (const hit of hitsIn(text, entries, used)) {
      // A mark that overlaps an earlier one in this text is left for a later text.
      if (hit.at < pos) continue;
      parts.push(
        text.slice(pos, hit.at),
        <Term key={hit.at} id={hit.id}>
          {text.slice(hit.at, hit.end)}
        </Term>,
      );
      used.add(hit.id);
      pos = hit.end;
    }
    if (parts.length === 0) return text;
    parts.push(text.slice(pos));
    return parts;
  });
}

export function Term({ id, children }: { id: TermId; children: ReactNode }) {
  const [state, dispatch] = useReducer(termReducer, TERM_CLOSED);
  const root = useRef<HTMLSpanElement>(null);
  const popover = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    if (!state.open) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && dispatch("escape");
    const onDown = (e: PointerEvent) => !root.current?.contains(e.target as Node) && dispatch("outside");
    document.addEventListener("keydown", onKey);
    document.addEventListener("pointerdown", onDown);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("pointerdown", onDown);
    };
  }, [state.open]);

  // Keep the popover inside the visible screen: no sideways scrolling, even at 320 px. It moves by its
  // position, not a transform, so the page's scrollable width follows it; and it fits the visual viewport,
  // which is narrower than the layout's when something else on the page overflows.
  useLayoutEffect(() => {
    const el = popover.current;
    if (!state.open || !el) return;
    el.style.left = "";
    const box = el.getBoundingClientRect();
    const vv = window.visualViewport;
    const shift = popoverShift(box.left, box.width, vv ? vv.offsetLeft + vv.width : document.documentElement.clientWidth);
    if (shift > 0) el.style.left = `-${shift}px`;
  }, [state.open]);

  return (
    <span data-term="" ref={root} className="relative">
      <button
        type="button"
        aria-expanded={state.open}
        onPointerEnter={(e) => e.pointerType === "mouse" && dispatch("hover")}
        onPointerLeave={(e) => e.pointerType === "mouse" && dispatch("unhover")}
        onFocus={() => dispatch("focus")}
        onBlur={() => dispatch("blur")}
        onClick={() => dispatch("press")}
        className="cursor-help underline decoration-dotted decoration-ink-muted underline-offset-2 hover:decoration-ink focus-visible:rounded-sm focus-visible:outline focus-visible:outline-2 focus-visible:outline-series-kalshi"
      >
        {children}
      </button>
      <span role="status">
        {state.open && (
          <span
            ref={popover}
            className="absolute left-0 top-full z-20 mt-1 block w-max max-w-[min(18rem,calc(100vw-1rem))] rounded-lg border border-border bg-surface-raised px-3 py-2 text-left text-xs font-normal normal-case leading-relaxed tracking-normal text-ink-secondary shadow-lg"
          >
            <span className="font-medium text-ink">{GLOSSARY_BY_ID[id].term}: </span>
            {GLOSSARY_BY_ID[id].definition}
          </span>
        )}
      </span>
    </span>
  );
}
