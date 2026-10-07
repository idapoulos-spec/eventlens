// Lists and edits what the collectors collect, as the database owner.
//
//   pnpm db:watchlist list [--all]
//   pnpm db:watchlist add <kind> <key> [--intervals 60,1440] [--inactive] [--note "…"]
//   pnpm db:watchlist activate|deactivate|remove <kind> <key>
//
// Kinds: kalshi_series, kalshi_event, kalshi_market, stock. Intervals default to every one the
// kind allows (Kalshi: 60,1440 minutes; stocks: 30min,1day). Reads DATABASE_OWNER_URL from the
// environment (`.env.local` locally). Removing or deactivating an item keeps what was collected.

import { parseArgs } from "node:util";
import { openOwnerSql } from "@/lib/store/db";
import type { SessionSql } from "@/lib/store/sql";
import {
  readWatchlist,
  removeWatchItem,
  saveWatchItem,
  setWatchActive,
  validateWatchItem,
  type WatchItem,
} from "@/lib/store/watchlist";

const USAGE = `Usage:
  pnpm db:watchlist list [--all]
  pnpm db:watchlist add <kind> <key> [--intervals 60,1440] [--inactive] [--note "…"]
  pnpm db:watchlist activate|deactivate|remove <kind> <key>
Kinds: kalshi_series, kalshi_event, kalshi_market, stock`;

function print(items: WatchItem[]): void {
  if (!items.length) return console.log("(empty)");
  for (const item of items) {
    const state = item.active ? "active  " : "inactive";
    console.log(`${state}  ${item.kind.padEnd(13)}  ${item.key.padEnd(16)}  ${item.intervals.join(",").padEnd(11)}  ${item.note ?? ""}`);
  }
}

async function run(sql: SessionSql, command: string, args: string[], values: Record<string, unknown>): Promise<number> {
  if (command === "list") {
    print(await readWatchlist(sql, { includeInactive: Boolean(values.all) }));
    return 0;
  }
  const [kind = "", key = ""] = args;
  const intervals = typeof values.intervals === "string" ? values.intervals.split(",").map((s) => s.trim()) : undefined;
  const item = validateWatchItem({ kind, key, intervals });
  if (!item.ok) {
    console.error(item.message);
    return 1;
  }

  if (command === "add") {
    const note = typeof values.note === "string" ? values.note : null;
    print([await saveWatchItem(sql, { ...item, active: !values.inactive, note })]);
    return 0;
  }
  const found =
    command === "remove"
      ? await removeWatchItem(sql, item.kind, item.key)
      : command === "activate" || command === "deactivate"
        ? await setWatchActive(sql, item.kind, item.key, command === "activate")
        : null;
  if (found === null) {
    console.error(USAGE);
    return 1;
  }
  console.log(found ? `${command}: ${item.kind} ${item.key}` : `${item.kind} ${item.key} isn't on the watchlist.`);
  return found ? 0 : 1;
}

async function main(): Promise<number> {
  const { positionals, values } = parseArgs({
    allowPositionals: true,
    options: {
      all: { type: "boolean" },
      intervals: { type: "string" },
      inactive: { type: "boolean" },
      note: { type: "string" },
    },
  });
  const [command, ...args] = positionals;
  if (!command) {
    console.error(USAGE);
    return 1;
  }
  const sql = await openOwnerSql();
  if (!sql) {
    console.error("DATABASE_OWNER_URL isn't set. Set it in .env.local (see db/README.md).");
    return 1;
  }
  try {
    return await run(sql, command, args, values);
  } finally {
    await sql.end();
  }
}

main().then((code) => {
  process.exitCode = code;
});
