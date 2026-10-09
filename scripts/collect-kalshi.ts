// Collects the watchlist's Kalshi candles into the data store, as the collector role.
//
//   pnpm collect:kalshi [--mode incremental|backfill|repair] [--trigger local|schedule|manual]
//
// incremental (the default): new candles since the last run, newly listed markets' history, and
// up to 25 gap windows. backfill: every market's whole history again. repair: every gap. Reads
// COLLECTOR_DATABASE_URL from the environment (`.env.local` locally; a secret of the `collector`
// environment in GitHub Actions). Prints counts and tickers only: Actions logs are public. Exits
// 1 unless the run is ok, so a failing schedule sends GitHub's failure email.

import { parseArgs } from "node:util";
import { collectKalshi, describeError } from "@/lib/collect/kalshi/collect";
import { openCollectorSql } from "@/lib/store/db";
import type { RunMode, RunTrigger } from "@/lib/store/schema";

const MODES: readonly RunMode[] = ["incremental", "backfill", "repair"];
const TRIGGERS: readonly RunTrigger[] = ["local", "schedule", "manual"];

const log = (line: string) => console.log(`[collect-kalshi] ${line}`);

// lib/store/sql.ts turns a dropped connection into a failed query, but anything else thrown
// outside a query would crash Node and print the error, which can name the host. Print the
// error's name only; the next run marks this one failed (closeAbandonedRuns).
process.on("uncaughtException", (err) => {
  console.error(`[collect-kalshi] failed: ${describeError(err)}`);
  process.exit(1);
});

const mb = (bytes: number) => `${(bytes / 1024 / 1024).toFixed(1)} MB`;

async function main(): Promise<number> {
  const { values } = parseArgs({
    options: {
      mode: { type: "string", default: "incremental" },
      trigger: { type: "string", default: "local" },
    },
  });
  const mode = values.mode as RunMode;
  const trigger = values.trigger as RunTrigger;
  if (!MODES.includes(mode) || !TRIGGERS.includes(trigger)) {
    console.error(`Usage: --mode ${MODES.join("|")} --trigger ${TRIGGERS.join("|")}`);
    return 1;
  }

  // Connection errors can name the host, and Postgres errors quote rows: never print a message.
  const sql = await openCollectorSql().catch((err: unknown) => {
    console.error(`[collect-kalshi] couldn't connect: ${describeError(err)}`);
    return undefined;
  });
  if (sql === undefined) return 1;
  if (!sql) {
    console.error("[collect-kalshi] COLLECTOR_DATABASE_URL isn't set. Set it in .env.local (see db/README.md).");
    return 1;
  }
  const started = Date.now();
  try {
    const run = await collectKalshi({ sql, mode, trigger, log });
    if (run.store) {
      const { markets, candles, coverage, bytes } = run.store;
      log(`stored: ${markets} markets; ${candles["60"]} hourly and ${candles["1440"]} daily candles; ${coverage} coverage ranges`);
      log(
        `size: database ${mb(bytes.database)}; kalshi_candles ${mb(bytes.candles)}, ` +
          `kalshi_markets ${mb(bytes.markets)}, fetch_coverage ${mb(bytes.coverage)}`,
      );
    }
    log(`finished in ${Math.round((Date.now() - started) / 1000)} s`);
    return run.status === "ok" ? 0 : 1;
  } catch (err) {
    console.error(`[collect-kalshi] failed: ${describeError(err)}`);
    return 1;
  } finally {
    await sql.end().catch(() => {});
  }
}

main()
  .catch((err: unknown) => {
    console.error(`[collect-kalshi] failed: ${describeError(err)}`);
    return 1;
  })
  .then((code) => {
    process.exitCode = code;
  });
