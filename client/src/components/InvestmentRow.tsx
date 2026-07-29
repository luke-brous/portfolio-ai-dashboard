import type { Investment } from "../types";
import DeltaRibbon from "./DeltaRibbon";

function formatPrice(n: number): string {
  return n.toLocaleString("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

function formatAsOf(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  // Render a local timestamp so the row
  // does not flicker every minute as the Date.now() advances.
  const datePart = d.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
  });
  const timePart = d.toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
  });
  return `${datePart}, ${timePart}`;
}

/**
 * Investment row. When `onDelete` is provided, a trash button appears on
 * the right; otherwise the row renders exactly as before so any other
 * call site (e.g. a future read-only summary) keeps its current shape.
 */
export default function InvestmentRow({
  investment,
  onDelete,
  isDeleting = false,
}: {
  investment: Investment;
  onDelete?: () => void;
  isDeleting?: boolean;
}) {
  const latest = investment.latestSnapshot?.price ?? null;
  const dollarDelta = investment.delta?.price ?? null;
  const percentDelta = investment.delta?.percentChange ?? null;
  const asOf = investment.latestSnapshot?.timestamp ?? null;

  return (
    <div className="flex items-center gap-6 px-5 py-4 bg-white border border-slate-200 rounded-lg">
      {/* Identity */}
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline gap-3">
          <span className="font-semibold tracking-wide text-indigo-950">
            {investment.ticker}
          </span>
          <span className="text-sm text-slate-500 truncate">
            {investment.companyName}
          </span>
        </div>
      </div>

      {/* Price + delta */}
      <div className="flex flex-col items-end gap-1">
        <span className="font-semibold text-slate-900 tabular-nums">
          {latest !== null ? formatPrice(latest) : "—"}
        </span>
        <DeltaRibbon dollarDelta={dollarDelta} percentDelta={percentDelta} />
      </div>

      {/* As-of timestamp */}
      <div className="hidden sm:block text-xs text-slate-400 font-light tabular-nums w-40 text-right">
        {formatAsOf(asOf)}
      </div>

      {/* Delete control — opt-in via onDelete. {@link Advisor} passes
         * the useDeleteInvestment mutation; here we just render the
         * affordance. */}
      {onDelete && (
        <button
          type="button"
          onClick={onDelete}
          disabled={isDeleting}
          aria-label={`Delete ${investment.ticker}`}
          title={`Delete ${investment.ticker}`}
          className="shrink-0 rounded-md p-2 text-slate-400 transition-colors duration-200 hover:bg-red-50 hover:text-red-600 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {/* Minimal inline trash glyph — avoids pulling in an icon
             * library per the spec's "no new component library" rule. */}
          <svg
            xmlns="http://www.w3.org/2000/svg"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            className="h-4 w-4"
            aria-hidden="true"
          >
            <path d="M3 6h18" />
            <path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
            <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />
            <path d="M10 11v6" />
            <path d="M14 11v6" />
          </svg>
        </button>
      )}
    </div>
  );
}
