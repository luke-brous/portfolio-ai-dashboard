import { useQuery } from "@tanstack/react-query";
import { apiGet } from "../lib/api";

export function useAuth() {
  return useQuery({
    queryKey: ["auth"],
    // `apiGet` rather than a hand-rolled fetch: it resolves the path against
    // the backend origin in one place (`apiUrl`), which also copes with an
    // unset VITE_BACKEND_URL by falling back to a relative path that Vite's
    // proxy forwards. Interpolating the env var here produced
    // `undefined/auth/me` — a 404 against the *frontend* origin — whenever
    // the var was missing. See the invariant in client/src/lib/api.ts.
    queryFn: async () => {
      const data = await apiGet<{ authed: boolean }>("/auth/me");
      return { isAuthed: data.authed };
    },
    refetchOnWindowFocus: false,
  });
}
