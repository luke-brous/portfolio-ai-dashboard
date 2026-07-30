import { useEffect } from "react";
import { Outlet } from "react-router-dom";
import { useAuth } from "../hooks/useAuth";
import { apiUrl } from "../lib/api";
import Navbar from "../components/Navbar";

export default function Landing() {
  const { data: authData, isLoading: authLoading } = useAuth();

  useEffect(() => {
    if (!authLoading && !authData?.isAuthed) {
      // `apiUrl` so the backend origin is resolved in one place — see the
      // invariant in client/src/lib/api.ts.
      window.location.replace(apiUrl("/auth/login"));
    }
  }, [authData, authLoading]);

  if (authLoading) {
    return (
      <div className="min-h-screen bg-slate-50 text-slate-900 font-['Outfit'] flex items-center justify-center">
        <div className="p-8 text-slate-600 font-light">Loading session...</div>
      </div>
    );
  }
  if (!authData?.isAuthed) return null;

  return (
    <div className="min-h-screen bg-slate-50 text-slate-900 font-['Outfit'] selection:bg-indigo-100 selection:text-indigo-900 flex flex-col">
      <Navbar />
      <main className="flex-grow w-full">
        <Outlet />
      </main>
    </div>
  );
}
