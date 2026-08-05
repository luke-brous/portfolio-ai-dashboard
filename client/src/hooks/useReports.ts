import { useMutation, useQuery } from "@tanstack/react-query";
import { apiGet, apiMutate } from "../lib/api";
import type {
  CrmSyncJob,
  ReportsResponse,
  SyncCorrespondenceAck,
} from "../types";

/**
 * GET /crm/nonprofits/:id/reports — recorded correspondence, newest first.
 *
 * `enabled` gates the fetch on the card being expanded, so the CRM list does
 * not fire one request per nonprofit on mount.
 *
 * Paths stay relative and go through `apiGet`, which resolves the backend
 * origin in one place (see lib/api.ts) — a bare relative fetch here would
 * arrive cookieless and 401.
 */
export function useReports(nonprofitId: number, enabled = true) {
  return useQuery<ReportsResponse>({
    queryKey: ["reports", nonprofitId],
    queryFn: () =>
      apiGet<ReportsResponse>(
        `/crm/nonprofits/${encodeURIComponent(String(nonprofitId))}/reports`,
      ),
    enabled,
  });
}

/**
 * POST /crm/nonprofits/:id/sync — kick off a correspondence sync.
 *
 * Resolves as soon as the server has accepted the job (202), which is
 * milliseconds, *not* when the sync finishes. The run calls Gemini serially
 * with an 8s throttle and can take a minute; waiting for it on the connection
 * is what let the proxy kill the request and surface it as a CORS error.
 * Watch `useSyncStatus` for the outcome.
 *
 * Errors still thrown here are the ones decided before the job starts: 400,
 * 404, and 422 for a nonprofit with no usable contactEmail.
 */
export function useSyncCorrespondence() {
  return useMutation<SyncCorrespondenceAck, Error, number>({
    mutationFn: (nonprofitId) =>
      apiMutate<SyncCorrespondenceAck>(
        "POST",
        `/crm/nonprofits/${encodeURIComponent(String(nonprofitId))}/sync`,
      ),
  });
}

/**
 * GET /crm/nonprofits/:id/sync-status — progress of the background sync.
 *
 * Polls every 2s while a run is in flight and stops as soon as it settles, so
 * an idle panel costs one request on mount and nothing after. Because the
 * status lives on the server rather than in this component, a reload
 * mid-run picks the progress back up instead of looking idle.
 */
export function useSyncStatus(nonprofitId: number, enabled = true) {
  return useQuery<CrmSyncJob>({
    queryKey: ["crm-sync-status", nonprofitId],
    queryFn: () =>
      apiGet<CrmSyncJob>(
        `/crm/nonprofits/${encodeURIComponent(String(nonprofitId))}/sync-status`,
      ),
    enabled,
    refetchInterval: (query) =>
      query.state.data?.status === "running" ? 2000 : false,
  });
}
