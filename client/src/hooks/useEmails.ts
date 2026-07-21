import { useQuery } from "@tanstack/react-query";

interface Email {
  id: string;
  from: string;
  subject: string;
  body: string;
  date: string;
}

const fetchEmails = async (label: string, dateRange: { after: string; before: string }): Promise<Email[]> => {
  const queryParams = new URLSearchParams({
    label,
    after: dateRange.after,
    before: dateRange.before,
  });

  const backendURL = (import.meta as any).env.VITE_BACKEND_URL;

  const response = await fetch(`${backendURL}/gmail/messages?${queryParams.toString()}`, {
    credentials: "include",
  });

  if (!response.ok) {
    throw new Error("Failed to fetch emails");
  }

  const data = await response.json();
  return data.messages || [];
};

export function useEmails(label: string | null, dateRange: { after: string; before: string } | null) {
  return useQuery({
    queryKey: ['emails', label, dateRange?.after, dateRange?.before],
    queryFn: () => fetchEmails(label!, dateRange!),
    enabled: false,
  });
}
