/**
 * Per-nonprofit job state for the CRM correspondence sync.
 *
 * Why this exists
 * ---------------
 * The sync calls Gemini once per message with a throttle between calls, so a
 * full run takes far longer than a proxy will hold a silent HTTP connection
 * open. Running it inside the request meant the connection was killed
 * mid-run — and a proxy-terminated response carries no CORS headers, so the
 * browser reported it as a CORS failure while the server quietly finished and
 * committed the rows. The work looked lost when it wasn't, which is the worst
 * version of that bug.
 *
 * `POST /crm/nonprofits/:id/sync` now starts the run and returns 202
 * immediately; the client polls `GET /crm/nonprofits/:id/sync-status`. Every
 * request is then milliseconds long, which is what puts the timeout out of
 * reach regardless of how long the run itself takes. That is the fix — the
 * previous wall-clock budget only narrowed the window, because throttle ×
 * message count can never fit inside a request budget.
 *
 * State is in-memory and per-process, exactly like the Finnhub equivalent in
 * ./syncState.ts. A restart loses an in-flight job's status, which is
 * cosmetic: reports already committed are durable, and the next run dedups
 * against them before spending anything on Gemini.
 */

export type CrmSyncStatus = "running" | "done" | "error";

/** What a completed run did. Mirrors the old inline response body. */
export interface CrmSyncResult {
  nonprofitId: number;
  /** Gmail hits from this sender in the window, before dedup. */
  matched: number;
  /** Already stored, so never sent to Gemini. */
  skipped: number;
  summarized: number;
  failed: number;
  /** Unseen mail remained beyond this run's cap — another sync will get it. */
  hasMore: boolean;
}

/**
 * A run that failed outright (as opposed to individual messages failing,
 * which are counted in `CrmSyncResult.failed`).
 *
 * `status` carries the HTTP code the old inline route would have returned, so
 * the client keeps the same ability to distinguish "sign in again" (401) from
 * "create the label" (422) from "Gmail is down" (502).
 */
export interface CrmSyncError {
  message: string;
  status: number;
}

export interface CrmSyncJob {
  nonprofitId: number;
  status: CrmSyncStatus;
  startedAt: Date;
  finishedAt: Date | null;
  /** Populated only when `status === "done"`. */
  result: CrmSyncResult | null;
  /** Populated only when `status === "error"`. */
  error: CrmSyncError | null;
}

const jobs = new Map<number, CrmSyncJob>();

/**
 * Claim the sync slot for a nonprofit.
 *
 * Returns `false` if a run is already in flight, in which case the caller must
 * NOT start another — this is the guard that keeps an impatient double-click
 * from running two Gemini loops over the same mailbox. Returns `true` (having
 * recorded a fresh `running` job) when the caller owns the run.
 */
export function beginCrmSync(nonprofitId: number): boolean {
  if (jobs.get(nonprofitId)?.status === "running") return false;
  jobs.set(nonprofitId, {
    nonprofitId,
    status: "running",
    startedAt: new Date(),
    finishedAt: null,
    result: null,
    error: null,
  });
  return true;
}

/** Record a successful run. No-op if the job vanished (test reset mid-run). */
export function completeCrmSync(
  nonprofitId: number,
  result: CrmSyncResult,
): void {
  const job = jobs.get(nonprofitId);
  if (!job) return;
  job.status = "done";
  job.finishedAt = new Date();
  job.result = result;
  job.error = null;
}

/** Record a run that failed as a whole. */
export function failCrmSync(nonprofitId: number, error: CrmSyncError): void {
  const job = jobs.get(nonprofitId);
  if (!job) return;
  job.status = "error";
  job.finishedAt = new Date();
  job.result = null;
  job.error = error;
}

export function isCrmSyncInFlight(nonprofitId: number): boolean {
  return jobs.get(nonprofitId)?.status === "running";
}

/**
 * The latest job for a nonprofit, or `null` if none has ever run in this
 * process. Callers render `null` as "idle".
 */
export function getCrmSyncJob(nonprofitId: number): CrmSyncJob | null {
  return jobs.get(nonprofitId) ?? null;
}

/** Reset the state for testing purposes. */
export function resetCrmSyncStateForTesting(): void {
  jobs.clear();
}
