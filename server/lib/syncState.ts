/**
 * Shared state for the scheduled Finnhub sync.
 *
 * `server/index.ts` is the sole writer (via recordSyncStart / recordSyncFinish
 * / recordSyncRun); `server/routes/portfolio.ts` and the legacy `/sync/last-run`
 * handler are read-only consumers. Keeping the state out of `index.ts` avoids a
 * route-module → index circular import.
 */

export type SyncRun = {
  at: Date;
  ok: boolean;
  note: string;
};

let lastSyncRun: SyncRun | null = null;
let inFlight = false;

/** Mark a tick as having entered the run. Idempotent if already true. */
export function recordSyncStart(): void {
  inFlight = true;
}

/** Clear the in-flight flag. Safe to call multiple times. */
export function recordSyncFinish(): void {
  inFlight = false;
}

/** Reset the state for testing purposes. */
export function resetSyncStateForTesting(): void {
  lastSyncRun = null;
  inFlight = false;
}

/** Record the outcome of a completed (or failed) sync run. */
export function recordSyncRun(outcome: SyncRun): void {
  lastSyncRun = outcome;
}

export function isSyncInFlight(): boolean {
  return inFlight;
}

export function getLastRun(): SyncRun | null {
  return lastSyncRun;
}

/** Combined view used by the new /portfolio/sync-status handler. */
export function getSyncSnapshot(): {
  lastRun: SyncRun | null;
  inFlight: boolean;
} {
  return { lastRun: lastSyncRun, inFlight };
}
