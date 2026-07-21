import { useQuery } from "@tanstack/react-query";

export function useLabels() {
  return useQuery<{ labels: any[] }, Error>({
    queryKey: ["labels"],
    queryFn: async () => {
      const backendURL = (import.meta as any).env.VITE_BACKEND_URL;
      const response = await fetch(`${backendURL}/gmail/labels`, {
        credentials: "include",
      });
      if (!response.ok) {
        throw new Error("Failed to fetch labels");
      }
      return response.json();
    },
  });
}
