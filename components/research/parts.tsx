// Small building blocks shared by the Research panel's cards.

import type { ReactNode } from "react";
import { formatSigned } from "@/lib/format";

export const plural = (n: number, [one, many]: [string, string]) => `${n.toLocaleString("en-US")} ${n === 1 ? one : many}`;
export const fmtR = (r: number | null) => (r === null ? "—" : formatSigned(r, 2));

interface SegmentOption<T> {
  value: T;
  label: string;
  disabled?: boolean;
  title?: string;
}

export function Segmented<T extends string | number>({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: T;
  options: SegmentOption<T>[];
  onChange: (value: T) => void;
}) {
  return (
    <div>
      <span className="mb-1.5 block text-xs font-medium text-ink-secondary">{label}</span>
      <div role="group" aria-label={label} className="grid auto-cols-fr grid-flow-col rounded-lg border border-border p-0.5 text-xs sm:inline-grid">
        {options.map((o) => (
          <button
            key={o.value}
            type="button"
            aria-pressed={value === o.value}
            disabled={o.disabled}
            title={o.disabled ? o.title : undefined}
            onClick={() => onChange(o.value)}
            className={`rounded-md px-3 py-2.5 transition disabled:cursor-not-allowed disabled:opacity-40 sm:py-1.5 ${
              value === o.value ? "bg-surface-raised text-ink" : "text-ink-muted hover:text-ink-secondary"
            }`}
          >
            {o.label}
          </button>
        ))}
      </div>
    </div>
  );
}

/** A warning that never relies on color alone: an icon and a label. */
export function Flag({ children }: { children: ReactNode }) {
  return (
    <span className="inline-flex items-center gap-1.5 rounded-md border border-warn/40 bg-surface-raised px-2 py-1 text-xs text-ink">
      <span aria-hidden className="flex h-3.5 w-3.5 items-center justify-center rounded-full bg-warn text-[0.6rem] font-bold text-page">
        !
      </span>
      {children}
    </span>
  );
}

/** Caption and caveats under a chart: one plain-English line, then smaller print. */
export function Caption({ lead, caveats }: { lead: ReactNode; caveats: ReactNode }) {
  return (
    <div className="mt-3 space-y-1.5">
      <p className="text-sm text-ink-secondary">{lead}</p>
      <p className="text-xs text-ink-muted">{caveats}</p>
    </div>
  );
}

export function Table({ head, rows }: { head: string[]; rows: string[][] }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-left tabular-nums">
        <thead className="text-ink-muted">
          <tr>
            {head.map((h) => (
              <th key={h} scope="col" className="py-1 pr-4 font-medium">
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="text-ink-secondary">
          {rows.map((r) => (
            <tr key={r[0]} className="border-t border-border">
              {r.map((c, i) => (
                <td key={i} className="py-1 pr-4">
                  {c}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** The chart's values as a table, collapsed by default. */
export function ValuesTable({ head, rows }: { head: string[]; rows: string[][] }) {
  return (
    <details className="mt-3 text-xs">
      <summary className="cursor-pointer text-ink-muted hover:text-ink-secondary">Show values</summary>
      <div className="mt-2">
        <Table head={head} rows={rows} />
      </div>
    </details>
  );
}
