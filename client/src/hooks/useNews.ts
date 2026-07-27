import { apiGet } from "../lib/api";
import { useQuery } from "@tanstack/react-query";
import type { NewsResponse } from "../types";

export function useNews(days = 7) {
  const { data, isLoading, isError } = useQuery({
    queryKey: ["news", days],
    queryFn: () => apiGet<NewsResponse>(`/portfolio/news?days=${days}`),
    refetchInterval: 60_000, // 1 minute
  });

  return {
    news: data?.news ?? [],
    count: data?.count ?? 0,
    isLoading,
    isError,
  };
}
