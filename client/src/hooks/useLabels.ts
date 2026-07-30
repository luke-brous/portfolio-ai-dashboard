import { useQuery } from "@tanstack/react-query";
import { apiGet } from "../lib/api";
import type { Label } from "../types/index";

export function useLabels() {
  return useQuery<{ labels: Label[] }, Error>({
    queryKey: ["labels"],
    queryFn: () => apiGet<{ labels: Label[] }>("/gmail/labels"),
  });
}
