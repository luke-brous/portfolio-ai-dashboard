/**
 * Shared state for the scheduled Finnhub sync.
 *
 * `server/index.ts` is the sole writer (via recordSyncStart / recordSyncFinish
 * / recordSyncRun); `server/routes/portfolio.ts` and the legacy `/sync/last-run`
 * handler are read-only consumers. Keeping the state out of `index.ts` avoids a
 * route-module → index circular import.
 *
 * The last run is held both in memory (fast, but lost on every restart) and in
 * the `sync_runs` table (survives restarts). Reads prefer the in-memory value
 * — it is always at least as fresh — and fall back to the table.
 */

import { logger } from "../logger";
import * as sqliteSyncRunStore from "../db/syncRuns";

export type SyncRun = {
  at: Date;
  ok: boolean;
  note: string;
  tickersProcessed?: number;
  tickersSkipped?: number;
  tickersFailed?: number;
};

/**
 * Persistence port. Defaults to the SQLite implementation; tests install a
 * fake through `__setSyncRunStoreForTests` rather than mocking the db module,
 * because `mock.module` in Bun is process-global and permanent.
 */
export type SyncRunStore = {
  insertSyncRun(run: SyncRun): void;
  selectLatestSyncRun(): SyncRun | null;
  selectLastDataAt(): Date | null;
};

let store: SyncRunStore = sqliteSyncRunStore;

let lastSyncRun: SyncRun | null = null;
let inFlight = false;

/** Swap the persistence port. Pass null to restore the SQLite default. */
export function __setSyncRunStoreForTests(next: SyncRunStore | null): void {
  store = next ?? sqliteSyncRunStore;
}

/** Mark a tick as having entered the run. Idempotent if already true. */
export function recordSyncStart(): void {
  inFlight = true;
}

/** Clear the in-flight flag. Safe to call multiple times. */
export function recordSyncFinish(): void {
  inFlight = false;
}

/**
 * Reset the in-memory state for testing purposes.
 *
 * Deliberately does NOT touch the `sync_runs` table — clearing the cache is
 * how a test simulates a process restart, and the point of that simulation is
 * that the persisted row is still there. Tests that want an empty table should
 * truncate it themselves (or install a fake store).
 */
export function resetSyncStateForTesting(): void {
  lastSyncRun = null;
  inFlight = false;
}

/** Record the outcome of a completed (or failed) sync run. */
export function recordSyncRun(outcome: SyncRun): void {
  lastSyncRun = outcome;
  try {
    store.insertSyncRun(outcome);
  } catch (err) {
    // A logging table must never take down a sync. The in-memory value is
    // already set, so the running process still reports the correct status;
    // only restart-survival is lost.
    const msg = err instanceof Error ? err.message : String(err);
    logger.error(`[sync] Could not persist sync run: ${msg}`);
  }
}

export function isSyncInFlight(): boolean {
  return inFlight;
}

/**
 * In-memory last run only. Kept synchronous and cache-only so the legacy
 * `/sync/last-run` handler in server/index.ts and the existing unit tests
 * keep their current semantics.
 */
export function getLastRun(): SyncRun | null {
  return lastSyncRun;
}

/** Last run, falling back to the persisted row after a restart. */
export function getLastRunPersisted(): SyncRun | null {
  if (lastSyncRun) return lastSyncRun;
  try {
    return store.selectLatestSyncRun();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error(`[sync] Could not read persisted sync run: ${msg}`);
    return null;
  }
}

/** Combined view used by the new /portfolio/sync-status handler. */
export function getSyncSnapshot(): {
  lastRun: SyncRun | null;
  inFlight: boolean;
} {
  return { lastRun: lastSyncRun, inFlight };
}

/**
 * Everything GET /portfolio/sync-status needs to describe freshness.
 *
 * `lastDataAt` is reported separately from `lastRun` on purpose. A restart at
 * 4pm re-runs the sync, skips all 45 tickers because they already have a
 * snapshot for today (syncMarketData.ts), and records a new run of "now" — so
 * `lastRun` alone would claim "0m ago" when no fresh market data was pulled.
 * The client derives staleness from `lastDataAt` first.
 */
export function getSyncFreshness(): {
  lastRun: SyncRun | null;
  lastDataAt: Date | null;
  inFlight: boolean;
} {
  let lastDataAt: Date | null = null;
  try {
    lastDataAt = store.selectLastDataAt();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error(`[sync] Could not read last data timestamp: ${msg}`);
  }

  return { lastRun: getLastRunPersisted(), lastDataAt, inFlight };
}
