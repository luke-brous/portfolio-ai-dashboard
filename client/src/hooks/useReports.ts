import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiGet, apiMutate } from "../lib/api";
import type { ReportsResponse, SyncCorrespondenceResult } from "../types";

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
 * POST /crm/nonprofits/:id/sync — pull new mail from the nonprofit's
 * contactEmail, summarise it, record it.
 *
 * The route calls Gemini serially with an 8s throttle, so this mutation can
 * legitimately run for a minute or more. Callers should keep the button
 * disabled for its whole duration rather than assuming a fast reply.
 */
export function useSyncCorrespondence() {
  const queryClient = useQueryClient();
  return useMutation<SyncCorrespondenceResult, Error, number>({
    mutationFn: (nonprofitId) =>
      apiMutate<SyncCorrespondenceResult>(
        "POST",
        `/crm/nonprofits/${encodeURIComponent(String(nonprofitId))}/sync`,
      ),
    onSuccess: (result) => {
      queryClient.invalidateQueries({
        queryKey: ["reports", result.nonprofitId],
      });
    },
  });
}
