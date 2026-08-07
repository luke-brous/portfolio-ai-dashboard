import { apiGet } from "../lib/api";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";

type SyncRun = {
  at: string;
  ok: boolean;
  note: string;
};

type SyncStatusResponse = {
  lastRun: SyncRun | null;
  lastDataAt: string | null;
  inFlight: boolean | null;
  marketOpen: boolean | null;
  staleAfterMinutes: number | null;
};

export type SyncHealth = "syncing" | "fresh" | "stale" | "unknown";

/**
 * Fallback if the server omits the threshold (older build, or a failed fetch).
 * The server normally computes this per request from the market session — see
 * server/lib/marketHours.ts — so this value should rarely be used.
 */
const DEFAULT_STALE_AFTER_MINUTES = 90;

export function useSyncStatus() {
  const { data, isLoading, isError } = useQuery({
    queryKey: ["sync-status"],
    queryFn: () => apiGet<SyncStatusResponse>("/portfolio/sync-status"),
    refetchInterval: 60_000,
    // A tab left open overnight otherwise shows a stale age until the next
    // interval fires; correct it the moment the user comes back.
    refetchOnWindowFocus: true,
  });

  // Relative age changes even when the data does not, so the query alone
  // cannot drive the badge — without this tick it would freeze at whatever
  // age it had when the fetch last resolved.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(id);
  }, []);

  const lastRunAt = data?.lastRun?.at ?? null;
  const lastDataAt = data?.lastDataAt ?? null;
  const inFlight = data?.inFlight ?? false;
  const marketOpen = data?.marketOpen ?? false;
  const staleAfterMinutes =
    data?.staleAfterMinutes ?? DEFAULT_STALE_AFTER_MINUTES;

  // Prefer when data was actually pulled over when the scheduler last ticked.
  // A restart that skips every ticker (all already have today's snapshot)
  // records a fresh run but pulls nothing — reading `lastRun` here would
  // report "0m ago" for data that could be a day old.
  const freshnessAt = lastDataAt ?? lastRunAt;

  let health: SyncHealth = "unknown";
  if (inFlight) {
    health = "syncing";
  } else if (freshnessAt) {
    const ageMs = now - new Date(freshnessAt).getTime();
    if (!Number.isNaN(ageMs)) {
      health = ageMs < staleAfterMinutes * 60_000 ? "fresh" : "stale";
    }
  }

  return {
    health,
    freshnessAt,
    lastRun: lastRunAt,
    lastDataAt,
    inFlight,
    marketOpen,
    staleAfterMinutes,
    isLoading,
    isError,
  };
}
