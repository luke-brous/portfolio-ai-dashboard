import { useQuery } from "@tanstack/react-query";
import { apiGet } from "../lib/api";
import type { Email } from "../types";

const fetchEmails = async (
  label: string,
  dateRange: { after: string; before: string },
): Promise<Email[]> => {
  const queryParams = new URLSearchParams({
    label,
    after: dateRange.after,
    before: dateRange.before,
  });

  const data = await apiGet<{ messages?: Email[] }>(
    `/gmail/messages?${queryParams.toString()}`,
  );
  return data.messages || [];
};

export function useEmails(
  label: string | null,
  dateRange: { after: string; before: string } | null,
) {
  return useQuery({
    queryKey: ["emails", label, dateRange?.after, dateRange?.before],
    queryFn: () => fetchEmails(label!, dateRange!),
    enabled: false,
  });
}
