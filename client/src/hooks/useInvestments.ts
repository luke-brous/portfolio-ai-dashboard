import { apiGet } from "../lib/api";
import { useQuery } from "@tanstack/react-query";
import type { InvestmentwithSnapshot } from "../types";

export function useInvestments() {
  const { data, isLoading, isError } = useQuery({
    queryKey: ["investments"],
    queryFn: () =>
      apiGet<{ investments: InvestmentwithSnapshot[] }>(
        "/portfolio/investments",
      ),
    refetchInterval: 60000, // 1 minute
  });

  return {
    investments: data?.investments ?? [],
    isLoading,
    isError,
  };
}
