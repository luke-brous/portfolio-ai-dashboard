import { useState } from "react";
import { useReports, useSyncCorrespondence } from "../hooks/useReports";
import { ApiError } from "../lib/api";
import type { Nonprofit, SyncCorrespondenceResult } from "../types";

function formatDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "Unknown date";
  return d.toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

/**
 * Summarises what a sync actually did, in the user's terms. "Nothing new"
 * is the common outcome on a repeat click and deserves to read as success
 * rather than as a silent no-op.
 */
function syncMessage(r: SyncCorrespondenceResult): string {
  if (r.matched === 0) {
    // Naming the label matters: the usual cause of a zero-match sync is mail
    // that exists but was never filed, not a grantee who has gone quiet.
    return "No mail from this address under the Nonprofit label in the last 90 days.";
  }
  if (r.summarized === 0 && r.failed === 0) {
    return `Nothing new — all ${r.matched} message${r.matched === 1 ? "" : "s"} already recorded.`;
  }
  const parts = [
    `Recorded ${r.summarized} new message${r.summarized === 1 ? "" : "s"}`,
  ];
  if (r.skipped > 0) parts.push(`${r.skipped} already on file`);
  if (r.failed > 0) parts.push(`${r.failed} could not be summarised`);
  const base = `${parts.join(", ")}.`;
  return r.hasMore ? `${base} Refresh again for more.` : base;
}

export default function CorrespondencePanel({
  nonprofit,
}: {
  nonprofit: Nonprofit;
}) {
  const { data, isPending, isError, error } = useReports(nonprofit.id);
  const sync = useSyncCorrespondence();

  const [syncResult, setSyncResult] = useState<string | null>(null);
  const [syncError, setSyncError] = useState<string | null>(null);

  const reports = data?.reports ?? [];
  const total = data?.total ?? 0;

  const handleSync = async () => {
    setSyncResult(null);
    setSyncError(null);
    try {
      setSyncResult(syncMessage(await sync.mutateAsync(nonprofit.id)));
    } catch (err) {
      // 422 is the "row can't support this" case — no contactEmail stored.
      // Surfacing the server's own message keeps the fix actionable instead
      // of showing a bare status code.
      if (err instanceof ApiError && err.status === 422) {
        setSyncError(
          `${nonprofit.name} has no contact email, so there is no sender to match correspondence against. Add one via Edit.`,
        );
      } else {
        setSyncError(
          err instanceof Error
            ? err.message
            : "Could not refresh correspondence.",
        );
      }
    }
  };

  return (
    <div className="mt-2 rounded-xl border border-slate-200 bg-slate-50 px-6 py-5">
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
        <h3 className="text-sm font-semibold uppercase tracking-wide text-slate-500">
          Correspondence
          {total > 0 && (
            <span className="ml-2 font-normal normal-case tracking-normal text-slate-400">
              {reports.length === total
                ? `${total} recorded`
                : `showing ${reports.length} of ${total}`}
            </span>
          )}
        </h3>
        <button
          type="button"
          onClick={() => void handleSync()}
          disabled={sync.isPending}
          className="self-start sm:self-auto rounded-md border border-indigo-200 bg-white px-3 py-1.5 text-sm font-medium text-indigo-700 shadow-sm transition-colors duration-200 hover:bg-indigo-50 disabled:cursor-not-allowed disabled:opacity-60"
        >
          {sync.isPending ? "Refreshing…" : "Refresh correspondence"}
        </button>
      </div>

      {sync.isPending && (
        <p className="mt-3 text-sm text-slate-500" aria-live="polite">
          Reading Gmail and summarising. This can take a minute — each message
          is summarised individually.
        </p>
      )}

      {syncResult && !sync.isPending && (
        <p
          className="mt-3 rounded-md border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-800"
          aria-live="polite"
        >
          {syncResult}
        </p>
      )}

      {syncError && (
        <p
          role="alert"
          className="mt-3 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700"
        >
          {syncError}
        </p>
      )}

      <div className="mt-4">
        {isPending ? (
          <p className="text-sm text-slate-500">Loading correspondence…</p>
        ) : isError ? (
          <p
            role="alert"
            className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700"
          >
            Failed to load correspondence: {error?.message ?? "Unknown error"}
          </p>
        ) : reports.length === 0 ? (
          <p className="text-sm text-slate-500">
            Nothing recorded yet.{" "}
            {nonprofit.contactEmail ? (
              <>
                Use <span className="font-medium">Refresh correspondence</span>{" "}
                to pull recent mail from{" "}
                <span className="font-mono">{nonprofit.contactEmail}</span>{" "}
                filed under the <span className="font-medium">Nonprofit</span>{" "}
                label.
              </>
            ) : (
              <>Add a contact email via Edit to enable syncing.</>
            )}
          </p>
        ) : (
          <ol className="space-y-3">
            {reports.map((report) => (
              <li
                key={report.id}
                className="rounded-lg border border-slate-200 bg-white px-4 py-3"
              >
                <time
                  dateTime={report.date}
                  className="text-xs font-medium uppercase tracking-wide text-slate-400"
                >
                  {formatDate(report.date)}
                </time>
                <p className="mt-1 text-sm leading-relaxed text-slate-700">
                  {report.summary}
                </p>
              </li>
            ))}
          </ol>
        )}
      </div>
    </div>
  );
}
