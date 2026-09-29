"use client";

import type { StockSearchProps } from "@/lib/search/types";
import { inputClass, inputProps, labelTextClass } from "./field";

/**
 * Stock ticker field. Stub: a plain text input that reports every edit through
 * onSelect; no search yet. The name "stock" lets the form submit as
 * /?stock=… before JavaScript loads.
 */
export function StockSearch({ value, onSelect, invalid }: StockSearchProps) {
  return (
    <label className="block">
      <span className={labelTextClass}>Stock ticker</span>
      <input
        {...inputProps}
        name="stock"
        className={inputClass}
        value={value}
        aria-invalid={invalid || undefined}
        onChange={(e) => onSelect(e.target.value, null)}
        placeholder="e.g. NVDA"
        maxLength={12}
      />
    </label>
  );
}
