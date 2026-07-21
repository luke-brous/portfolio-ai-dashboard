import { useMutation, useQueryClient } from "@tanstack/react-query";

interface Summary {
  id: string;
  from: string;
  subject: string;
  date: string;
  summary: string;
}

interface SummarizeRequest {
  emails: any[];
}

export function useSummarizeMutation() {
  const backendURL = (import.meta as any).env.VITE_BACKEND_URL;

  return useMutation<Summary[], Error, SummarizeRequest>({
    mutationFn: async (data: SummarizeRequest) => {
      const response = await fetch(`${backendURL}/summarize`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify(data),
        credentials: "include",
      });

      if (!response.ok) {
        throw new Error("Failed to summarize emails");
      }

      const result = await response.json();
      return result.summaries;
    },
  });
}
