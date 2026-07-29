import { useState } from "react";
import { useCreateInvestment } from "../hooks/useInvestments";
import { ApiError } from "../lib/api";
import type { Investment } from "../types";

/**
 * Controlled create form for a new portfolio holding.
 *
 * Client-side validation deliberately mirrors the server's Zod schema in
 * server/routes/portfolio.ts so a user filled in correctly cannot be
 * rejected at the wire for shape reasons:
 *
 *   ticker        required, trimmed, uppercase-transformed, ≤ 10 chars
 *   companyName   required, trimmed
 *   sector        required, trimmed
 *   shares        required, positive, finite number
 *
 * UX rules:
 *  - Inline field errors show ONLY after the user has clicked submit
 *    at least once. Validation runs on every input, but `submitAttempted`
 *    gates visibility so an untouched form doesn't greet the user with
 *    four red error spans the moment it opens. This matches the
 *    convention in CrmCard's empty-state copy elsewhere in the app.
 *  - Submit is allowed at any time; if it's invalid the click flips
 *    `submitAttempted` on, errors appear, and the click is a no-op.
 *  - On successful submit, fields reset and `onDone()` is called so
 *    the parent (currently Advisor's holdings section) can close the
 *    form.
 *  - 409 (duplicate ticker) is shown distinctly from 400 (validation)
 *    and 5xx (server) — never collapsed into a single generic banner.
 */
export default function InvestmentForm({
  onDone,
}: {
  onDone?: () => void;
} = {}) {
  const create = useCreateInvestment();
  const [submitAttempted, setSubmitAttempted] = useState(false);

  const [ticker, setTicker] = useState("");
  const [companyName, setCompanyName] = useState("");
  const [sector, setSector] = useState("");
  const [shares, setShares] = useState<string>("");

  const reset = () => {
    setTicker("");
    setCompanyName("");
    setSector("");
    setShares("");
  };

  // Compute validation unconditionally — the boolean drives `isInvalid`
  // for the submit guard regardless of whether the user has submitted.
  // Visibility of error text, however, is gated on `submitAttempted`.
  const clientErrors: Partial<Record<keyof FormState, string>> = {};
  const trimmedTicker = ticker.trim();
  if (!trimmedTicker) clientErrors.ticker = "Ticker is required.";
  else if (trimmedTicker.length > 10)
    clientErrors.ticker = "Ticker must be 10 characters or fewer.";

  if (!companyName.trim()) clientErrors.companyName = "Company name is required.";
  if (!sector.trim()) clientErrors.sector = "Sector is required.";

  const sharesNum = shares === "" ? Number.NaN : Number(shares);
  if (shares === "" || Number.isNaN(sharesNum))
    clientErrors.shares = "Shares must be a number.";
  else if (sharesNum <= 0) clientErrors.shares = "Shares must be positive.";
  else if (!Number.isFinite(sharesNum))
    clientErrors.shares = "Shares must be a finite number.";

  const isInvalid = Object.keys(clientErrors).length > 0;

  const onSubmit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setSubmitAttempted(true);
    if (isInvalid) return;

    try {
      await create.mutateAsync({
        ticker: trimmedTicker,
        companyName: companyName.trim(),
        sector: sector.trim(),
        shares: sharesNum,
      });
      reset();
      onDone?.();
    } catch {
      // The form's render branches handle `create.error` reactively —
      // setting it via TanStack Query's internal store on throw.
    }
  };

  const errorKind: null | "session" | "duplicate" | "validation" | "server" = (() => {
    const err = create.error;
    if (!err) return null;
    if (err instanceof ApiError) {
      if (err.status === 401) return "session";
      if (err.status === 409) return "duplicate";
      if (err.status === 400) return "validation";
      if (err.status >= 500) return "server";
      return "validation"; // unknown 4xx → assume it was the client's fault
    }
    return "server";
  })();

  return (
    <form
      onSubmit={onSubmit}
      className="rounded-xl border border-slate-200 bg-white px-5 py-5 shadow-sm space-y-4"
      aria-label="Add a new investment"
    >
      <div className="grid gap-4 sm:grid-cols-2 sm:gap-5">
        <Field
          label="Ticker"
          name="ticker"
          value={ticker}
          onChange={setTicker}
          placeholder="AAPL"
          maxLength={10}
          clientError={submitAttempted ? clientErrors.ticker : undefined}
          autoComplete="off"
        />
        <Field
          label="Company"
          name="companyName"
          value={companyName}
          onChange={setCompanyName}
          placeholder="Apple Inc."
          clientError={submitAttempted ? clientErrors.companyName : undefined}
          autoComplete="off"
        />
        <Field
          label="Sector"
          name="sector"
          value={sector}
          onChange={setSector}
          placeholder="Technology"
          clientError={submitAttempted ? clientErrors.sector : undefined}
          autoComplete="off"
        />
        <Field
          label="Shares"
          name="shares"
          value={shares}
          onChange={setShares}
          placeholder="10"
          inputMode="decimal"
          clientError={submitAttempted ? clientErrors.shares : undefined}
          autoComplete="off"
        />
      </div>

      {errorKind === "session" && (
        <div
          role="alert"
          className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900"
        >
          <p className="font-medium">
            We couldn&rsquo;t authenticate your session. Please log in again
            to save this holding.
          </p>
          <a
            href="/auth/login"
            className="mt-2 inline-flex items-center rounded-md bg-white px-3 py-1.5 text-xs font-semibold text-amber-900 shadow-sm ring-1 ring-amber-300 transition-colors duration-200 hover:bg-amber-100"
          >
            Log in
          </a>
        </div>
      )}
      {errorKind === "duplicate" && (
        <p
          role="alert"
          className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800"
        >
          That ticker is already in your portfolio. Choose a different ticker
          or delete the existing one first.
        </p>
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
          Couldn't save this investment (server error). Please retry shortly.
        </p>
      )}

      <div className="flex items-center justify-end gap-3 pt-1">
        <button
          type="button"
          onClick={reset}
          disabled={create.isPending}
          className="text-sm font-medium text-slate-600 transition-colors duration-200 hover:text-slate-900 disabled:opacity-50"
        >
          Reset
        </button>
        <button
          type="submit"
          disabled={(submitAttempted && isInvalid) || create.isPending}
          className="rounded-md bg-indigo-600 px-4 py-2 text-sm font-semibold text-white shadow-sm transition-colors duration-200 hover:bg-indigo-700 disabled:cursor-not-allowed disabled:bg-indigo-300"
        >
          {create.isPending ? "Saving…" : "Add holding"}
        </button>
      </div>
    </form>
  );
}

type FormState = {
  ticker: string;
  companyName: string;
  sector: string;
  shares: string;
};

function Field({
  label,
  name,
  value,
  onChange,
  placeholder,
  maxLength,
  inputMode,
  clientError,
  autoComplete,
}: {
  label: string;
  name: keyof FormState;
  value: string;
  onChange: (next: string) => void;
  placeholder?: string;
  maxLength?: number;
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
        maxLength={maxLength}
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
