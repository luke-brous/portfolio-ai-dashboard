import { useMutation } from "@tanstack/react-query";
import { apiMutate } from "../lib/api";
import type { Email, Summary } from "../types";

interface SummarizeRequest {
  emails: Email[];
}

export function useSummarizeMutation() {
  return useMutation<Summary[], Error, SummarizeRequest>({
    mutationFn: async (data: SummarizeRequest) => {
      const result = await apiMutate<{ summaries: Summary[] }>(
        "POST",
        "/summarize",
        data,
      );
      return result.summaries;
    },
  });
}
