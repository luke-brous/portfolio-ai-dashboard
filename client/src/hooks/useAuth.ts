import { useQuery } from "@tanstack/react-query";

export function useAuth() {
  return useQuery({
    queryKey: ["auth"],
    queryFn: async () => {
      const backendURL = (import.meta as any).env.VITE_BACKEND_URL;
      const response = await fetch(`${backendURL}/auth/me`, {
        credentials: "include",
      });
      if (!response.ok) {
        throw new Error("Failed to fetch session");
      }
      const data = await response.json();
      return { isAuthed: data.authed };
    },
    refetchOnWindowFocus: false,
  });
}
