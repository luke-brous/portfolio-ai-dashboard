import { apiGet } from "../lib/api";
import { useQuery } from "@tanstack/react-query";

type SyncStatus = {
  lastSynced: string | null;
  isSyncing: boolean | null;
};

export function useSyncStatus() {
  // useQuery keyed on [sync-status] from GET /portfolio/sync-status route
  // with a refetch interval of a minute

  const { data, isLoading, isError } = useQuery({
    queryKey: ["sync-status"],
    queryFn: () => apiGet<SyncStatus>("/portfolio/sync-status"),
    refetchInterval: 60000, // 1 minute
  });

  return {
    isSyncing: data?.isSyncing ?? false,
    lastSynced: data?.lastSynced ?? null,
    isLoading,
    isError,
  };
}
