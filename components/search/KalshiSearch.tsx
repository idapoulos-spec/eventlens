"use client";

import type { KalshiSearchProps } from "@/lib/search/types";
import { inputClass, inputProps, labelTextClass } from "./field";

/**
 * Kalshi market ticker field. Stub: a plain text input that reports every edit
 * through onSelect; no search yet. The name "kalshi" lets the form submit as
 * /?kalshi=… before JavaScript loads.
 */
export function KalshiSearch({ value, onSelect }: KalshiSearchProps) {
  return (
    <label className="block">
      <span className={labelTextClass}>Kalshi market ticker</span>
      <input
        {...inputProps}
        name="kalshi"
        className={inputClass}
        value={value}
        onChange={(e) => onSelect(e.target.value, null)}
        placeholder="e.g. KXFEDDECISION-26OCT-H25"
        maxLength={100}
      />
    </label>
  );
}
