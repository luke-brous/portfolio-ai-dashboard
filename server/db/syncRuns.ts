/**
 * SQLite-backed persistence for the scheduled Finnhub sync.
 *
 * Split out of server/lib/syncState.ts so that module keeps its cheap
 * in-memory hot path (`inFlight`) free of DB imports, and so tests can swap
 * the whole store through `__setSyncRunStoreForTests` instead of reaching for
 * `mock.module("../db/client")` — which is process-global and permanent in
 * Bun (see CLAUDE.md, Testing Strategy).
 *
 * Import direction: this module imports `db` from ./client, never from "..".
 * server/index.ts mounts the routes and the routes read this state, so going
 * back through ".." would close a cycle. See server/db/client.ts.
 */

import { desc } from "drizzle-orm";
import { db } from "./client";
import { priceSnapshots, syncRuns } from "./schema";
// Type-only, so it is erased at runtime and does not create an import cycle
// with server/lib/syncState.ts (which imports this module for real).
import type { SyncRun } from "../lib/syncState";

/** Append one completed (or failed) sync outcome. */
export function insertSyncRun(run: SyncRun): void {
  db.insert(syncRuns)
    .values({
      at: run.at,
      ok: run.ok,
      note: run.note,
      tickersProcessed: run.tickersProcessed ?? 0,
      tickersSkipped: run.tickersSkipped ?? 0,
      tickersFailed: run.tickersFailed ?? 0,
    })
    .run();
}

/** Newest recorded run, or null when the table is empty. */
export function selectLatestSyncRun(): SyncRun | null {
  const row = db
    .select()
    .from(syncRuns)
    .orderBy(desc(syncRuns.at))
    .limit(1)
    .get();

  if (!row) return null;
  return {
    at: row.at,
    ok: row.ok,
    note: row.note,
    tickersProcessed: row.tickersProcessed,
    tickersSkipped: row.tickersSkipped,
    tickersFailed: row.tickersFailed,
  };
}

/**
 * Timestamp of the newest price snapshot — the honest answer to "when was the
 * market data last actually refreshed".
 *
 * This is deliberately not `MAX(timestamp)`: with `mode: "timestamp"` Drizzle
 * stores the column as **seconds**, so a raw aggregate comes back as a bare
 * number that the caller has to remember to multiply by 1000. Ordering by the
 * column and taking one row lets Drizzle do the Date conversion itself.
 */
export function selectLastDataAt(): Date | null {
  const row = db
    .select({ timestamp: priceSnapshots.timestamp })
    .from(priceSnapshots)
    .orderBy(desc(priceSnapshots.timestamp))
    .limit(1)
    .get();

  return row?.timestamp ?? null;
}
