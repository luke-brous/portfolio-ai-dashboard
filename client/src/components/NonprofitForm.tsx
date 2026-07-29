import { useState } from "react";
import {
  useCreateNonprofit,
  useUpdateNonprofit,
} from "../hooks/useNonProfits";
import { ApiError } from "../lib/api";
import type { Nonprofit } from "../types";

/**
 * Dual-mode controlled form: create (no `existing` prop) or edit
 * (`existing` prefills the inputs and submit dispatches a PATCH).
 *
 * Client-side validation mirrors server/routes/crm.ts:
 *   name             required, trimmed
 *   contactEmail     if provided, must be a valid email
 *   grantCycleDates  if provided, non-blank trimmed string
 *   grantAmount      if provided, positive finite number
 *   grantStatus      if provided, non-blank trimmed string
 *
 * Edit mode enforces that the user changes at least one field so PATCH
 * requests always carry a real diff.
 *
 * UX:
 *  - Inline error spans show ONLY after the user clicks submit (saved
 *    by `submitAttempted`). Mirrors the InvestmentForm behaviour so a
 *    freshly-opened form doesn't greet the user with red errors.
 *  - 401 (session expired) is surfaced distinctly from other failures
 *    with a re-login button, since the most common cause for hitting
 *    the write endpoints with no session is an in-memory session wipe
 *    (server restart) — CLAUDE.md §6.
 */
export default function NonprofitForm({
  existing,
  onDone,
}: {
  existing?: Nonprofit;
  onDone?: () => void;
}) {
  const isEdit = !!existing;
  const create = useCreateNonprofit();
  const update = useUpdateNonprofit();
  const [submitAttempted, setSubmitAttempted] = useState(false);

  const [name, setName] = useState(existing?.name ?? "");
  const [contactEmail, setContactEmail] = useState(
    existing?.contactEmail ?? "",
  );
  const [grantCycleDates, setCycle] = useState(
    existing?.grantCycleDates ?? "",
  );
  const [grantAmount, setAmount] = useState<string>(
    existing?.grantAmount != null ? String(existing.grantAmount) : "",
  );
  const [grantStatus, setStatus] = useState(existing?.grantStatus ?? "");

  const reset = () => {
    setName(existing?.name ?? "");
    setContactEmail(existing?.contactEmail ?? "");
    setCycle(existing?.grantCycleDates ?? "");
    setAmount(
      existing?.grantAmount != null ? String(existing.grantAmount) : "",
    );
    setStatus(existing?.grantStatus ?? "");
  };

  // Compute validation unconditionally so `isInvalid` correctly gates the
  // submit guard. *Visibility* is still gated by `submitAttempted`.
  const clientErrors: Partial<Record<string, string>> = {};
  if (!name.trim()) clientErrors.name = "Name is required.";

  const trimmedEmail = contactEmail.trim();
  if (trimmedEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmedEmail))
    clientErrors.contactEmail = "Enter a valid email address.";

  const trimmedCycle = grantCycleDates.trim();
  if (trimmedCycle && trimmedCycle.length === 0)
    clientErrors.grantCycleDates = "Cycle cannot be blank.";

  let amountNum: number | null = null;
  if (grantAmount.trim() !== "") {
    const parsed = Number(grantAmount);
    if (Number.isNaN(parsed) || !Number.isFinite(parsed))
      clientErrors.grantAmount = "Amount must be a number.";
    else if (parsed <= 0)
      clientErrors.grantAmount = "Amount must be positive.";
    else amountNum = parsed;
  }

  const isInvalid = Object.keys(clientErrors).length > 0;

  let noChange = false;
  if (isEdit && existing) {
    const matchesExisting =
      name.trim() === (existing.name ?? "").trim() &&
      trimmedEmail === (existing.contactEmail ?? "").trim() &&
      trimmedCycle === (existing.grantCycleDates ?? "").trim() &&
      (amountNum ?? null) === existing.grantAmount &&
      grantStatus.trim() === (existing.grantStatus ?? "").trim();
    noChange = matchesExisting;
  }

  const pending = create.isPending || update.isPending;

  const onSubmit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setSubmitAttempted(true);
    if (isInvalid || noChange) return;
    try {
      if (isEdit && existing) {
        await update.mutateAsync({
          id: existing.id,
          patch: {
            name: name.trim(),
            contactEmail: trimmedEmail === "" ? null : trimmedEmail,
            grantCycleDates: trimmedCycle === "" ? null : trimmedCycle,
            grantAmount: amountNum,
            grantStatus: grantStatus.trim() === "" ? null : grantStatus.trim(),
          },
        });
      } else {
        await create.mutateAsync({
          name: name.trim(),
          contactEmail: trimmedEmail === "" ? null : trimmedEmail,
          grantCycleDates: trimmedCycle === "" ? null : trimmedCycle,
          grantAmount: amountNum,
          grantStatus: grantStatus.trim() === "" ? null : grantStatus.trim(),
        });
        reset();
      }
      onDone?.();
    } catch {
      // Error rendering is reactive — see `currentError` below.
    }
  };

  const currentError = create.error ?? update.error;
  const errorKind: null | "session" | "validation" | "server" = (() => {
    if (!currentError) return null;
    if (currentError instanceof ApiError) {
      if (currentError.status === 401) return "session";
      if (currentError.status === 400 || currentError.status === 404)
        return "validation";
      if (currentError.status >= 500) return "server";
      return "validation";
    }
    return "server";
  })();

  return (
    <form
      onSubmit={onSubmit}
      className="rounded-xl border border-slate-200 bg-white px-5 py-5 shadow-sm space-y-4"
      aria-label={isEdit ? `Edit ${existing?.name ?? "nonprofit"}` : "Add a new nonprofit"}
    >
      <div className="grid gap-4 sm:grid-cols-2 sm:gap-5">
        <Field
          label="Name"
          name="name"
          value={name}
          onChange={setName}
          placeholder="Acme Foundation"
          clientError={submitAttempted ? clientErrors.name : undefined}
          autoComplete="off"
        />
        <Field
          label="Contact email"
          name="contactEmail"
          value={contactEmail}
          onChange={setContactEmail}
          placeholder="grants@example.org"
          clientError={submitAttempted ? clientErrors.contactEmail : undefined}
          autoComplete="off"
        />
        <Field
          label="Grant cycle"
          name="grantCycleDates"
          value={grantCycleDates}
          onChange={setCycle}
          placeholder="2026-01 → 2026-12"
          clientError={submitAttempted ? clientErrors.grantCycleDates : undefined}
          autoComplete="off"
        />
        <Field
          label="Grant amount (USD)"
          name="grantAmount"
          value={grantAmount}
          onChange={setAmount}
          placeholder="50000"
          inputMode="decimal"
          clientError={submitAttempted ? clientErrors.grantAmount : undefined}
          autoComplete="off"
        />
        <div className="sm:col-span-2">
          <Field
            label="Status"
            name="grantStatus"
            value={grantStatus}
            onChange={setStatus}
            placeholder="Active"
            clientError={submitAttempted ? clientErrors.grantStatus : undefined}
            autoComplete="off"
          />
        </div>
      </div>

      {errorKind === "session" && (
        <div
          role="alert"
          className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900"
        >
          <p className="font-medium">
            We couldn&rsquo;t authenticate your session. Please log in again
            to save this change.
          </p>
          <a
            href="/auth/login"
            className="mt-2 inline-flex items-center rounded-md bg-white px-3 py-1.5 text-xs font-semibold text-amber-900 shadow-sm ring-1 ring-amber-300 transition-colors duration-200 hover:bg-amber-100"
          >
            Log in
          </a>
        </div>
      )}
      {errorKind === "validation" && (
        <p
          role="alert"
          className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800"
        >
          The server rejected this submission. Double-check the fields and try
          again.
        </p>
      )}
      {errorKind === "server" && (
        <p
          role="alert"
          className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700"
        >
          Couldn't save these changes (server error). Please retry shortly.
        </p>
      )}

      <div className="flex items-center justify-end gap-3 pt-1">
        {isEdit && (
          <button
            type="button"
            onClick={onDone}
            disabled={pending}
            className="text-sm font-medium text-slate-600 transition-colors duration-200 hover:text-slate-900 disabled:opacity-50"
          >
            Cancel
          </button>
        )}
        <button
          type="button"
          onClick={reset}
          disabled={pending}
          className="text-sm font-medium text-slate-600 transition-colors duration-200 hover:text-slate-900 disabled:opacity-50"
        >
          Reset
        </button>
        <button
          type="submit"
          disabled={(submitAttempted && isInvalid) || noChange || pending}
          className="rounded-md bg-indigo-600 px-4 py-2 text-sm font-semibold text-white shadow-sm transition-colors duration-200 hover:bg-indigo-700 disabled:cursor-not-allowed disabled:bg-indigo-300"
        >
          {pending
            ? isEdit
              ? "Saving…"
              : "Creating…"
            : isEdit
              ? "Save changes"
              : "Add nonprofit"}
        </button>
      </div>
    </form>
  );
}

function Field({
  label,
  name,
  value,
  onChange,
  placeholder,
  inputMode,
  clientError,
  autoComplete,
}: {
  label: string;
  name: string;
  value: string;
  onChange: (next: string) => void;
  placeholder?: string;
  inputMode?: "text" | "decimal";
  clientError: string | undefined;
  autoComplete?: string;
}) {
  const hasError = !!clientError;
  return (
    <label className="block">
      <span className="mb-1 block text-xs font-semibold uppercase tracking-wide text-slate-500">
        {label}
      </span>
      <input
        type="text"
        name={name}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        inputMode={inputMode}
        autoComplete={autoComplete}
        aria-invalid={hasError || undefined}
        className={`w-full rounded-md border px-3 py-2 text-sm shadow-sm transition-colors duration-200 focus:outline-none focus:ring-2 ${
          hasError
            ? "border-red-300 bg-red-50 focus:border-red-400 focus:ring-red-200"
            : "border-slate-200 bg-white focus:border-indigo-400 focus:ring-indigo-200"
        }`}
      />
      {hasError && (
        <span className="mt-1 block text-xs text-red-600">{clientError}</span>
      )}
    </label>
  );
}
