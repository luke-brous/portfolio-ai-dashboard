import { apiGet, apiMutate } from "../lib/api";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { Investment } from "../types";

// GET /portfolio/investments — matches the existing list hook so the
// mutation hooks below can invalidate the same key for auto-refetch.
export function useInvestments() {
  const { data, isLoading, isError } = useQuery({
    queryKey: ["investments"],
    queryFn: () =>
      apiGet<{ investments: Investment[] }>("/portfolio/investments"),
    refetchInterval: 60000, // 1 minute
  });

  return {
    investments: data?.investments ?? [],
    isLoading,
    isError,
  };
}

// ---------- Mutations ----------------------------------------------------------
//
// Both hooks invalidate the `["investments"]` query key on success so the
// Advisor view refetches automatically — we do NOT manually patch the
// cache here because the existing read hook pollInterval refetches within
// 60s anyway, and the simpler invalidate-on-success pattern matches the
// mutation hook style used elsewhere in this codebase (see useSummarize.ts
// for the request/error pattern this hooks were modelled on).
//
// The two mutations share the standard fetch + credentials + ApiError
// throw contract surfaced by `apiMutate` so callers can discriminate 409
// (duplicate ticker) from 400 (validation) via `error.status`.

export interface CreateInvestmentInput {
  ticker: string;
  companyName: string;
  sector: string;
  shares: number;
}

export function useCreateInvestment() {
  const queryClient = useQueryClient();
  return useMutation<Investment, Error, CreateInvestmentInput>({
    mutationFn: (input) =>
      apiMutate<Investment>("POST", "/portfolio/investments", input),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["investments"] });
    },
  });
}

export function useDeleteInvestment() {
  const queryClient = useQueryClient();
  return useMutation<void, Error, number>({
    mutationFn: (id) =>
      apiMutate<void>("DELETE", `/portfolio/investments/${encodeURIComponent(String(id))}`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["investments"] });
    },
  });
}

// Re-export the row shape the existing GET returns so callers depending
// on the transformed DTO (with `latestSnapshot`/`delta`) don't need a
// second import from `types`.
export type { Investment };
