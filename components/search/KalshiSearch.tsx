"use client";

import { useEffect, useId, useReducer, useRef, useState, type FocusEvent, type KeyboardEvent } from "react";
import { MAX_SEARCH_QUERY_LENGTH } from "@/lib/search/api";
import type { KalshiSearchProps, KalshiSearchResult } from "@/lib/search/types";
import { inputClass, inputProps, labelTextClass } from "./field";
import {
  DEBOUNCE_MS,
  fetchKalshiSearch,
  initialSearchState,
  kalshiResults,
  searchableQuery,
  searchReducer,
  SLOW_SEARCH_MS,
} from "./KalshiSearchModel";
import { KalshiSearchPopup, searchAnnouncement } from "./KalshiSearchPopup";

/**
 * Kalshi market field: type a market ticker, or search open markets by keyword and pick
 * one (an ARIA combobox: arrows move, Enter picks, Escape closes). Enter with nothing
 * highlighted submits the form with the typed text. The name "kalshi" lets the form
 * submit as /?kalshi=… before JavaScript loads.
 */
export function KalshiSearch({ value, onSelect, invalid }: KalshiSearchProps) {
  const id = useId();
  const inputId = `${id}input`;
  const listboxId = `${id}listbox`;
  const optionId = (index: number) => `${id}option-${index}`;
  const [state, dispatch] = useReducer(searchReducer, initialSearchState);
  const wrapperRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const { query, status, attempt, active, open, results } = state;

  // TickerForm also changes the text itself (Clear, Back, a recent analysis). The search
  // for the old text no longer applies, so focusing the field doesn't show it again.
  const [ownText, setOwnText] = useState(value);
  if (value !== ownText) {
    setOwnText(value);
    dispatch({ type: "reset" });
  }

  // Search once typing pauses. A newer query aborts the older request, and the reducer
  // ignores any response that isn't for the current query.
  useEffect(() => {
    if (query === null || status !== "loading") return;
    const controller = new AbortController();
    const slowTimer = setTimeout(() => dispatch({ type: "slow", query }), SLOW_SEARCH_MS);
    const timer = setTimeout(async () => {
      try {
        const outcome = await fetchKalshiSearch(query, controller.signal);
        if (!outcome.ok) return dispatch({ type: "failed", query, message: outcome.message });
        kalshiResults.set(query, outcome.results);
        dispatch({ type: "loaded", query, results: outcome.results });
      } catch {
        // Aborted: a newer query or an unmount replaced this search.
      }
    }, DEBOUNCE_MS);
    return () => {
      clearTimeout(timer);
      clearTimeout(slowTimer);
      controller.abort();
    };
  }, [query, status, attempt]);

  // Keep the highlighted result in view as the arrow keys move through a scrolled list.
  useEffect(() => {
    if (open && active >= 0) document.getElementById(`${id}option-${active}`)?.scrollIntoView({ block: "nearest" });
  }, [id, open, active]);

  function pick(result: KalshiSearchResult) {
    setOwnText(result.ticker);
    onSelect(result.ticker, result);
    dispatch({ type: "reset" });
  }

  function onChange(text: string) {
    setOwnText(text);
    onSelect(text, null);
    const next = searchableQuery(text);
    dispatch({ type: "input", query: next, cached: next === null ? undefined : kalshiResults.get(next) });
  }

  function onKeyDown(e: KeyboardEvent<HTMLInputElement>) {
    if (e.nativeEvent.isComposing) return;
    switch (e.key) {
      case "ArrowDown":
      case "ArrowUp":
        if (query === null) return;
        e.preventDefault(); // Don't move the caret.
        dispatch({ type: "move", by: e.key === "ArrowDown" ? 1 : -1 });
        return;
      case "Enter": {
        const result = open && status !== "error" ? results[active] : undefined;
        if (result) {
          e.preventDefault(); // Pick instead of submitting; the next Enter analyzes.
          pick(result);
        } else {
          dispatch({ type: "close" });
        }
        return;
      }
      case "Escape":
        if (open) {
          e.preventDefault();
          dispatch({ type: "close" });
        }
        return;
    }
  }

  // Close when focus leaves the field, but not when it moves to the popup's "Try again" button.
  function onBlur(e: FocusEvent) {
    if (!wrapperRef.current?.contains(e.relatedTarget as Node | null)) dispatch({ type: "close" });
  }

  const expanded = open && status !== "error" && results.length > 0;

  return (
    <div ref={wrapperRef} className="relative" onBlur={onBlur}>
      <label htmlFor={inputId} className={labelTextClass}>
        Kalshi market
      </label>
      <input
        {...inputProps}
        ref={inputRef}
        id={inputId}
        name="kalshi"
        role="combobox"
        aria-autocomplete="list"
        aria-expanded={expanded}
        aria-controls={listboxId}
        aria-activedescendant={expanded && active >= 0 ? optionId(active) : undefined}
        aria-invalid={invalid || undefined}
        className={inputClass}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={onKeyDown}
        onFocus={() => dispatch({ type: "open" })}
        placeholder="Search markets or paste a ticker"
        maxLength={MAX_SEARCH_QUERY_LENGTH}
      />
      <KalshiSearchPopup
        state={state}
        listboxId={listboxId}
        optionId={optionId}
        onPick={pick}
        onHighlight={(index) => dispatch({ type: "highlight", index })}
        onRetry={() => {
          dispatch({ type: "retry" });
          inputRef.current?.focus();
        }}
      />
      <p role="status" className="sr-only">
        {searchAnnouncement(state)}
      </p>
    </div>
  );
}
