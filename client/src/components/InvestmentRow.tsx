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
  // Render a stable, human-friendly local timestamp so the row
  // does not flicker every minute as `Date.now()` advances.
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

function computePercentDelta(
  latest: number | null,
  previous: number | null,
): number | null {
  if (latest === null || previous === null || previous === 0) return null;
  return ((latest - previous) / previous) * 100;
}

export default function InvestmentRow({
  investment,
}: {
  investment: Investment;
}) {
  const latest = investment.latestSnapshot?.price ?? null;
  const previous = investment.previousSnapshot?.price ?? null;
  const dollarDelta = investment.delta;
  const percentDelta = computePercentDelta(latest, previous);
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
    </div>
  );
}
