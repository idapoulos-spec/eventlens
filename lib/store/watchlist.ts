// What the collectors collect. Only the owner edits it (`pnpm db:watchlist`); collectors read the
// active items.

import { validateKalshiTicker, validateStockTicker } from "@/lib/validation";
import type { WatchKind } from "./schema";
import type { Sql } from "./sql";

export const WATCH_KINDS: readonly WatchKind[] = ["kalshi_series", "kalshi_event", "kalshi_market", "stock"];

/** The intervals each kind of item can collect: Kalshi candle periods in minutes, or Twelve Data intervals. */
export const WATCH_INTERVALS: Record<WatchKind, readonly string[]> = {
  kalshi_series: ["60", "1440"],
  kalshi_event: ["60", "1440"],
  kalshi_market: ["60", "1440"],
  stock: ["30min", "1day"],
};

export interface WatchItem {
  id: number;
  kind: WatchKind;
  key: string;
  intervals: string[];
  active: boolean;
  note: string | null;
  addedAt: number;
  updatedAt: number;
}

export interface WatchInput {
  kind: string;
  key: string;
  intervals?: string[];
}

export type ValidatedWatch = { ok: true; kind: WatchKind; key: string; intervals: string[] } | { ok: false; message: string };

/** Checks a kind, key, and intervals before they reach the database. Intervals default to every one the kind allows. */
export function validateWatchItem({ kind, key, intervals }: WatchInput): ValidatedWatch {
  if (!(WATCH_KINDS as readonly string[]).includes(kind)) {
    return { ok: false, message: `Kind must be one of ${WATCH_KINDS.join(", ")}.` };
  }
  const watchKind = kind as WatchKind;
  const ticker = watchKind === "stock" ? validateStockTicker(key) : validateKalshiTicker(key);
  if (!ticker.ok) return { ok: false, message: ticker.message };

  const allowed = WATCH_INTERVALS[watchKind];
  const chosen = intervals?.length ? [...new Set(intervals)] : [...allowed];
  const unknown = chosen.filter((i) => !allowed.includes(i));
  if (unknown.length) return { ok: false, message: `${kind} intervals must be from ${allowed.join(", ")}, not ${unknown.join(", ")}.` };
  return { ok: true, kind: watchKind, key: ticker.value, intervals: chosen };
}

interface WatchRow {
  id: number;
  kind: WatchKind;
  key: string;
  intervals: string[];
  active: boolean;
  note: string | null;
  added_at: Date;
  updated_at: Date;
}

const COLUMNS = "id, kind, key, intervals, active, note, added_at, updated_at";

function toItem(row: WatchRow): WatchItem {
  return {
    id: row.id,
    kind: row.kind,
    key: row.key,
    intervals: row.intervals,
    active: row.active,
    note: row.note,
    addedAt: row.added_at.getTime(),
    updatedAt: row.updated_at.getTime(),
  };
}

/** Watchlist items, by kind then key; only active ones unless `includeInactive`. */
export async function readWatchlist(
  sql: Sql,
  { kind, includeInactive = false }: { kind?: WatchKind; includeInactive?: boolean } = {},
): Promise<WatchItem[]> {
  const rows = await sql.query<WatchRow>(
    `select ${COLUMNS} from watchlist
      where ($1::text is null or kind = $1) and (active or $2)
      order by kind, key`,
    [kind ?? null, includeInactive],
  );
  return rows.map(toItem);
}

/** Adds an item, or updates the intervals, note, and active flag of one already listed. */
export async function saveWatchItem(
  sql: Sql,
  item: { kind: WatchKind; key: string; intervals: string[]; active?: boolean; note?: string | null },
): Promise<WatchItem> {
  const [row] = await sql.query<WatchRow>(
    `insert into watchlist (kind, key, intervals, active, note) values ($1, $2, $3, $4, $5)
     on conflict (kind, key) do update
       set intervals = excluded.intervals, active = excluded.active, note = excluded.note, updated_at = now()
     returning ${COLUMNS}`,
    [item.kind, item.key, item.intervals, item.active ?? true, item.note ?? null],
  );
  return toItem(row);
}

/** Turns collection of an item on or off, keeping what was collected. False if it isn't listed. */
export async function setWatchActive(sql: Sql, kind: WatchKind, key: string, active: boolean): Promise<boolean> {
  const rows = await sql.query(
    "update watchlist set active = $3, updated_at = now() where kind = $1 and key = $2 returning id",
    [kind, key, active],
  );
  return rows.length > 0;
}

/** Removes an item from the watchlist. Data already collected stays. False if it isn't listed. */
export async function removeWatchItem(sql: Sql, kind: WatchKind, key: string): Promise<boolean> {
  const rows = await sql.query("delete from watchlist where kind = $1 and key = $2 returning id", [kind, key]);
  return rows.length > 0;
}
