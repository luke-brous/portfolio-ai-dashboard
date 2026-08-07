import { useSyncStatus, type SyncHealth } from "../hooks/useSyncStatus";

function formatRelativeTime(iso: string | null): string {
  if (!iso) return "Never synced";
  const diffMs = Date.now() - new Date(iso).getTime();
  if (Number.isNaN(diffMs)) return "Never synced";
  const sec = Math.max(0, Math.floor(diffMs / 1000));
  if (sec < 60) return `Synced ${sec}s ago`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `Synced ${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `Synced ${hr}h ago`;
  const day = Math.floor(hr / 24);
  return `Synced ${day}d ago`;
}

// The tint carries the status on the whole badge, not just the dot: a 2px dot
// is not an adequate carrier for a red/green distinction (colour vision
// deficiency, small screens), so the border and background move with it.
const HEALTH_STYLES: Record<SyncHealth, { dot: string; badge: string }> = {
  syncing: {
    dot: "bg-indigo-500 animate-pulse",
    badge: "bg-indigo-50 border-indigo-200 text-indigo-700",
  },
  fresh: {
    dot: "bg-emerald-500",
    badge: "bg-emerald-50 border-emerald-200 text-emerald-700",
  },
  stale: {
    dot: "bg-red-500",
    badge: "bg-red-50 border-red-200 text-red-700",
  },
  unknown: {
    dot: "bg-slate-300",
    badge: "bg-white border-slate-200 text-slate-600",
  },
};

const LOADING_STYLE = {
  dot: "bg-slate-300 animate-pulse",
  badge: "bg-white border-slate-200 text-slate-600",
};

export default function SyncBadge() {
  const { health, freshnessAt, marketOpen, isLoading } = useSyncStatus();

  const style = isLoading ? LOADING_STYLE : HEALTH_STYLES[health];

  const relative = formatRelativeTime(freshnessAt);

  // Outside market hours the data is *supposed* to be hours old, so say why
  // rather than leaving "Synced 14h ago" looking like a fault.
  const text = isLoading
    ? "Loading sync status…"
    : health === "syncing"
      ? "Syncing…"
      : health === "stale"
        ? `Last ${relative.toLowerCase()}`
        : !marketOpen && freshnessAt
          ? `Market closed · ${relative.toLowerCase()}`
          : relative;

  // Exact timestamp on hover — the relative label is the summary, not the
  // whole answer, and "4h ago" is not enough to debug a stalled scheduler.
  const title =
    !isLoading && freshnessAt
      ? new Date(freshnessAt).toLocaleString()
      : undefined;

  return (
    <div
      className={`inline-flex items-center gap-2 px-3 py-1.5 rounded-full border text-sm ${style.badge}`}
      aria-live="polite"
      title={title}
    >
      <span
        className={`w-2 h-2 rounded-full ${style.dot}`}
        aria-hidden="true"
      />
      <span className="font-medium">{text}</span>
    </div>
  );
}
