"use client";

import { useEffect, useId, useReducer, useState, type KeyboardEvent } from "react";
import { MAX_SEARCH_QUERY_LENGTH, validateSearchQuery } from "@/lib/search/api";
import type { StockSearchProps, StockSearchResult } from "@/lib/search/types";
import { inputClass, inputProps, labelTextClass } from "./field";
import { cachedStockResults, fetchStockResults } from "./StockSearchFetch";
import { optionId, StockSearchList } from "./StockSearchList";
import {
  highlightedResult,
  initialStockSearchState,
  SEARCH_DEBOUNCE_MS,
  searchAnnouncement,
  SLOW_SEARCH_MS,
  stockSearchReducer,
} from "./StockSearchState";

/**
 * Stock field: type a ticker, or search US stocks and ETFs by ticker or company name.
 * Results appear once typing pauses. Arrow keys move through them, Enter picks the
 * highlighted one (or submits a typed ticker that is also the top result), and Escape
 * closes them. The name "stock" lets the form submit as /?stock=… before JavaScript loads.
 */
export function StockSearch({ value, onSelect, invalid }: StockSearchProps) {
  const inputId = useId();
  const listboxId = `${inputId}-results`;
  const [state, dispatch] = useReducer(stockSearchReducer, initialStockSearchState);
  const { query, status, open, active, results } = state;
  const expanded = open && results.length > 0;

  // TickerForm also changes the text itself (Clear, Back, a recent analysis). The search
  // for the old text no longer applies, so it isn't shown again.
  const [ownText, setOwnText] = useState(value);
  if (value !== ownText) {
    setOwnText(value);
    dispatch({ type: "reset" });
  }

  // Search once typing pauses. Another edit cancels the pending search or request.
  useEffect(() => {
    if (status !== "loading") return;
    const controller = new AbortController();
    const slowTimer = setTimeout(() => dispatch({ type: "slow", query }), SLOW_SEARCH_MS);
    const timer = setTimeout(async () => {
      const outcome = await fetchStockResults(query, controller.signal);
      if (!outcome) return;
      dispatch(
        outcome.ok
          ? { type: "loaded", query: outcome.query, results: outcome.results }
          : { type: "failed", query: outcome.query, message: outcome.message },
      );
    }, SEARCH_DEBOUNCE_MS);
    return () => {
      clearTimeout(timer);
      clearTimeout(slowTimer);
      controller.abort();
    };
  }, [query, status]);

  useEffect(() => {
    if (expanded && active >= 0) document.getElementById(optionId(listboxId, active))?.scrollIntoView({ block: "nearest" });
  }, [expanded, active, listboxId]);

  function edit(text: string) {
    setOwnText(text);
    onSelect(text, null);
    const normalized = validateSearchQuery(text);
    const q = normalized.ok ? normalized.value : "";
    dispatch({ type: "edit", query: q, cached: cachedStockResults(q) });
  }

  function pick(result: StockSearchResult) {
    setOwnText(result.symbol);
    onSelect(result.symbol, result);
    dispatch({ type: "reset" });
  }

  function onKeyDown(e: KeyboardEvent<HTMLInputElement>) {
    if (e.nativeEvent.isComposing) return;
    switch (e.key) {
      case "ArrowDown":
      case "ArrowUp":
        if (!query) return;
        e.preventDefault();
        if (e.altKey) dispatch({ type: e.key === "ArrowDown" ? "open" : "close" });
        else dispatch(open ? { type: "move", by: e.key === "ArrowDown" ? 1 : -1 } : { type: "open" });
        return;
      case "Enter": {
        const result = highlightedResult(state);
        // Nothing highlighted: the form submits what's typed.
        if (!result) return;
        // A typed ticker that is also the highlighted result submits right away. Otherwise
        // Enter fills in the result, and a second Enter submits.
        if (result.symbol !== value.trim().toUpperCase()) e.preventDefault();
        pick(result);
        return;
      }
      case "Escape":
        if (!open) return;
        e.preventDefault();
        dispatch({ type: "close" });
        return;
    }
  }

  return (
    <div className="relative">
      <label htmlFor={inputId} className={labelTextClass}>
        Stock or ETF
      </label>
      <input
        {...inputProps}
        id={inputId}
        name="stock"
        type="text"
        role="combobox"
        aria-autocomplete="list"
        aria-expanded={expanded}
        aria-controls={expanded ? listboxId : undefined}
        aria-activedescendant={expanded && active >= 0 ? optionId(listboxId, active) : undefined}
        aria-invalid={invalid || undefined}
        className={inputClass}
        value={value}
        onChange={(e) => edit(e.target.value)}
        onKeyDown={onKeyDown}
        onBlur={() => dispatch({ type: "close" })}
        placeholder="Ticker or name"
        maxLength={MAX_SEARCH_QUERY_LENGTH}
      />
      {open && (
        <StockSearchList
          state={state}
          listboxId={listboxId}
          onPick={pick}
          onHover={(index) => dispatch({ type: "hover", index })}
        />
      )}
      <p aria-live="polite" className="sr-only">
        {searchAnnouncement(state)}
      </p>
    </div>
  );
}
