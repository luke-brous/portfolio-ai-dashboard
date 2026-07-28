import { useQuery } from "@tanstack/react-query";
import { apiGet } from "../lib/api";
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
    queryFn: async () => {
      const backendURL = import.meta.env.VITE_BACKEND_URL;
      return apiGet<NonprofitsResponse>(`${backendURL}/crm/nonprofits`);
    },
  });
}
