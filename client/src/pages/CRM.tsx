import { useState } from "react";
import useNonProfits, { useDeleteNonprofit } from "../hooks/useNonProfits";
import CrmCard from "../components/CrmCard";
import CrmSkeleton from "../components/CrmSkeleton";
import NonprofitForm from "../components/NonprofitForm";
import type { Nonprofit } from "../types";

export default function CRM() {
  const { data, isPending, isError, error } = useNonProfits();
  const nonprofits = data?.nonprofits ?? [];
  const count = data?.count ?? 0;
  const total = data?.total ?? 0;

  // Track which row is being edited (inline collapse) and whether the
  // standalone create form is expanded. Both are local-only UI state
  // — no need to make them server state.
  const [editingId, setEditingId] = useState<number | null>(null);
  const [showCreate, setShowCreate] = useState(false);

  const del = useDeleteNonprofit();
  // Which row's delete is in flight, so only that row's button disables.
  const [pendingDeleteId, setPendingDeleteId] = useState<number | null>(null);
  // Delete failures are surfaced here rather than thrown away — a 401 or a
  // 500 from the route would otherwise look like a click that did nothing.
  const [deleteError, setDeleteError] = useState<string | null>(null);

  const handleDelete = async (np: Nonprofit) => {
    // Native window.confirm, matching the Advisor delete flow — no custom
    // modal component. The copy names the nonprofit and spells out that
    // its correspondence goes too, since that cascade isn't visible here.
    const ok = window.confirm(
      `Delete ${np.name}? This permanently removes the nonprofit and all correspondence recorded against it.`,
    );
    if (!ok) return;

    setDeleteError(null);
    setPendingDeleteId(np.id);
    try {
      await del.mutateAsync(np.id);
      // If the row being deleted was open for editing, close the form —
      // otherwise it would linger, bound to an id that no longer exists.
      setEditingId((cur) => (cur === np.id ? null : cur));
    } catch (err) {
      setDeleteError(
        err instanceof Error ? err.message : `Could not delete ${np.name}.`,
      );
    } finally {
      // Only clear if we're still the row in flight; a second delete
      // launched while this one was pending has already claimed the slot.
      setPendingDeleteId((cur) => (cur === np.id ? null : cur));
    }
  };

  return (
    <section className="max-w-4xl mx-auto px-6 py-12 md:py-16">
      <header className="mb-10 flex flex-col sm:flex-row sm:items-start sm:justify-between gap-4">
        <div>
          <h1 className="text-3xl md:text-4xl font-bold tracking-tight text-indigo-950">
            Foundation Management
          </h1>
          <p className="mt-2 text-slate-600 font-light">
            {total === 0
              ? "Foundation grants will appear here once the seed runs."
              : count === total
                ? `The ${total} nonprofit${total === 1 ? "" : "s"} we fund.`
                : `Showing ${count} of ${total} nonprofit${total === 1 ? "" : "s"} we fund.`}
          </p>
        </div>
        <button
          type="button"
          onClick={() => setShowCreate((v) => !v)}
          aria-expanded={showCreate}
          className="self-start rounded-md bg-indigo-600 px-4 py-2 text-sm font-semibold text-white shadow-sm transition-colors duration-200 hover:bg-indigo-700"
        >
          {showCreate ? "Close" : "Add nonprofit"}
        </button>
      </header>

      {showCreate && (
        <div className="mb-8">
          <NonprofitForm onDone={() => setShowCreate(false)} />
        </div>
      )}

      {deleteError && (
        <div
          role="alert"
          className="mb-6 rounded-md border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700"
        >
          {deleteError}
        </div>
      )}

      {isPending ? (
        <CrmSkeleton />
      ) : isError ? (
        <div
          role="alert"
          className="rounded-md border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700"
        >
          Failed to load nonprofits:{" "}
          {error?.message ?? error?.toString() ?? "Unknown error"}
        </div>
      ) : nonprofits.length === 0 ? (
        <div className="rounded-md border border-slate-200 bg-white px-6 py-12 text-center text-slate-500">
          No nonprofits yet — populate via{" "}
          <code className="font-mono text-slate-700">
            bun server/db/seed.ts
          </code>
          .
        </div>
      ) : (
        <div className="grid gap-4">
          {nonprofits.map((np) => (
            <NonprofitRow
              key={np.id}
              np={np}
              isEditing={editingId === np.id}
              onEdit={() =>
                setEditingId((prev) => (prev === np.id ? null : np.id))
              }
              onDone={() => setEditingId(null)}
              onDelete={() => void handleDelete(np)}
              isDeleting={pendingDeleteId === np.id}
            />
          ))}
        </div>
      )}
    </section>
  );
}

/**
 * Renders a nonprofit card OR its edit form, depending on `isEditing`.
 * The toggle lives in the parent so editing one row doesn't accidentally
 * collapse another (mutual exclusion isn't enforced — collapsing is just
 * a click on the same Edit button).
 */
function NonprofitRow({
  np,
  isEditing,
  onEdit,
  onDone,
  onDelete,
  isDeleting = false,
}: {
  np: Nonprofit;
  isEditing: boolean;
  onEdit: () => void;
  onDone: () => void;
  onDelete: () => void;
  isDeleting?: boolean;
}) {
  if (isEditing) {
    return <NonprofitForm existing={np} onDone={onDone} />;
  }
  // Render the Edit/Delete affordances as a header row above the card so
  // they never overlap the `grantStatus` pill that CrmCard anchors in the
  // card's top-right corner.
  return (
    <div className={isDeleting ? "opacity-60 transition-opacity" : undefined}>
      <div className="mb-1 flex justify-end gap-1">
        <button
          type="button"
          onClick={onEdit}
          disabled={isDeleting}
          aria-label={`Edit ${np.name}`}
          className="rounded-md px-3 py-1.5 text-sm font-medium text-slate-600 transition-colors duration-200 hover:bg-slate-100 hover:text-indigo-700 disabled:cursor-not-allowed disabled:opacity-50"
        >
          Edit
        </button>
        <button
          type="button"
          onClick={onDelete}
          disabled={isDeleting}
          aria-label={`Delete ${np.name}`}
          title={`Delete ${np.name}`}
          className="rounded-md px-3 py-1.5 text-sm font-medium text-slate-600 transition-colors duration-200 hover:bg-red-50 hover:text-red-600 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {isDeleting ? "Deleting…" : "Delete"}
        </button>
      </div>
      <CrmCard nonprofit={np} />
    </div>
  );
}
