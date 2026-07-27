import { useSyncStatus } from "../hooks/useSyncStatus";

function formatRelativeTime(iso: string | null): string {
  if (!iso) return "Not synced yet";
  const diffMs = Date.now() - new Date(iso).getTime();
  if (Number.isNaN(diffMs)) return "Not synced yet";
  const sec = Math.max(0, Math.floor(diffMs / 1000));
  if (sec < 60) return `Last synced ${sec}s ago`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `Last synced ${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `Last synced ${hr}h ago`;
  const day = Math.floor(hr / 24);
  return `Last synced ${day}d ago`;
}

export default function SyncBadge() {
  const { lastRun, inFlight, isLoading } = useSyncStatus();

  const dotClass = isLoading
    ? "bg-slate-300 animate-pulse"
    : inFlight
      ? "bg-indigo-500 animate-pulse"
      : lastRun
        ? "bg-emerald-500"
        : "bg-slate-300";

  const text = isLoading
    ? "Loading sync status…"
    : inFlight
      ? "Syncing…"
      : formatRelativeTime(lastRun);

  return (
    <div
      className="inline-flex items-center gap-2 px-3 py-1.5 rounded-full bg-white border border-slate-200 text-sm text-slate-600"
      aria-live="polite"
    >
      <span className={`w-2 h-2 rounded-full ${dotClass}`} aria-hidden="true" />
      <span className="font-medium">{text}</span>
    </div>
  );
}
