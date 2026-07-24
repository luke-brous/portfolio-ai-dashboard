import { apiGet } from "../lib/api";
import { useQuery } from "@tanstack/react-query";

type SyncRun = {
    at: string,
    ok: boolean,
    note: string,
}

type SyncStatusResponse = {
  lastRun: SyncRun | null;
  inFlight: boolean | null;
};

export function useSyncStatus() {
  // useQuery keyed on [sync-status] from GET /portfolio/sync-status route
  // with a refetch interval of a minute

  const { data, isLoading, isError } = useQuery({
    queryKey: ["sync-status"],
    queryFn: () => apiGet<SyncStatusResponse>("/portfolio/sync-status"),
    refetchInterval: 60000, // 1 minute
  });

  return {
    inFlight: data?.inFlight ?? false,
    lastRun: data?.lastRun?.at ?? null,
    isLoading,
    isError,
  };
}
