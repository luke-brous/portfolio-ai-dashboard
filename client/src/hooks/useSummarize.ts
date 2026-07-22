import { useMutation } from "@tanstack/react-query";
import type { Email, Summary } from "../types";

interface SummarizeRequest {
  emails: Email[];
}

export function useSummarizeMutation() {
  const backendURL = import.meta.env.VITE_BACKEND_URL;

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
