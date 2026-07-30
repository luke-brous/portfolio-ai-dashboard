import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiGet, apiMutate } from "../lib/api";
import type { Nonprofit } from "../types";

export interface NonprofitsResponse {
  // rows returned in this page
  count: number;
  // total in the underlying table
  total: number;
  // echoed from the query for client convenience
  limit: number;
  offset: number;
  nonprofits: Nonprofit[];
}

export default function useNonProfits() {
  return useQuery<NonprofitsResponse>({
    queryKey: ["nonprofits"],
    // `apiGet` resolves the backend origin itself (see lib/api.ts), so the
    // path stays relative here and reads/writes can't drift onto different
    // origins — which is what broke the create mutation with a 401.
    queryFn: () => apiGet<NonprofitsResponse>("/crm/nonprofits"),
  });
}

// ---------- Mutations ----------------------------------------------------------
//
// Naming follows the spec exactly: `useCreateNonprofit` / `useUpdateNonprofit`.
// Both invalidate the `["nonprofits"]` query key on success so the read
// hook refetches automatically — no manual cache patching.

export type CreateNonprofitInput = {
  name: string;
  contactEmail?: string | null;
  grantCycleDates?: string | null;
  grantAmount?: number | null;
  grantStatus?: string | null;
};

export type UpdateNonprofitInput = Partial<CreateNonprofitInput>;

export function useCreateNonprofit() {
  const queryClient = useQueryClient();
  return useMutation<Nonprofit, Error, CreateNonprofitInput>({
    mutationFn: (input) =>
      apiMutate<Nonprofit>("POST", "/crm/nonprofits", input),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["nonprofits"] });
    },
  });
}

/**
 * DELETE /crm/nonprofits/:id. Resolves to void — the route answers 204
 * with no body. Invalidates the list on success like its siblings.
 */
export function useDeleteNonprofit() {
  const queryClient = useQueryClient();
  return useMutation<void, Error, number>({
    mutationFn: (id) =>
      apiMutate<void>(
        "DELETE",
        `/crm/nonprofits/${encodeURIComponent(String(id))}`,
      ),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["nonprofits"] });
    },
  });
}

export function useUpdateNonprofit() {
  const queryClient = useQueryClient();
  return useMutation<
    Nonprofit,
    Error,
    { id: number; patch: UpdateNonprofitInput }
  >({
    mutationFn: ({ id, patch }) =>
      apiMutate<Nonprofit>(
        "PATCH",
        `/crm/nonprofits/${encodeURIComponent(String(id))}`,
        patch,
      ),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["nonprofits"] });
    },
  });
}
