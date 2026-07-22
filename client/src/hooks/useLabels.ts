import { useQuery } from "@tanstack/react-query";
import type { Label } from "../types/index";

export function useLabels() {
  return useQuery<{ labels: Label[] }, Error>({
    queryKey: ["labels"],
    queryFn: async () => {
      const backendURL = import.meta.env.VITE_BACKEND_URL;
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
