import type { Nonprofit } from "../types";

export default function CrmCard({ nonprofit }: { nonprofit: Nonprofit }) {
  const { name, contactEmail, grantAmount, grantCycleDates, grantStatus } =
    nonprofit;

  const formatGrant = (amount: number | null) =>
    amount == null
      ? "—"
      : amount.toLocaleString("en-US", {
          style: "currency",
          currency: "USD",
          maximumFractionDigits: 0,
        });

  const statusColor =
    grantStatus?.toLowerCase() === "active"
      ? "bg-emerald-50 text-emerald-700 border-emerald-200"
      : "bg-slate-50 text-slate-600 border-slate-200";

  return (
    <article className="rounded-xl border border-slate-200 bg-white px-6 py-5 shadow-sm transition-shadow duration-300 ease-in-out hover:shadow-md">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h2 className="text-lg font-semibold text-indigo-950">{name}</h2>
          {contactEmail && (
            <a
              href={`mailto:${contactEmail}`}
              className="mt-1 inline-block font-mono text-sm text-slate-500 transition-colors duration-300 ease-in-out hover:text-indigo-600"
            >
              {contactEmail}
            </a>
          )}
        </div>

        {grantStatus && (
          <span
            className={`shrink-0 inline-flex items-center rounded-full border px-2.5 py-0.5 text-xs font-medium ${statusColor}`}
          >
            {grantStatus}
          </span>
        )}
      </div>

      <dl className="mt-4 grid grid-cols-2 gap-x-6 gap-y-2 text-sm">
        <div>
          <dt className="text-xs uppercase tracking-wide text-slate-400">
            Grant
          </dt>
          <dd className="font-medium text-slate-700">
            {formatGrant(grantAmount)}
          </dd>
        </div>
        <div>
          <dt className="text-xs uppercase tracking-wide text-slate-400">
            Cycle
          </dt>
          <dd className="font-medium text-slate-700">
            {grantCycleDates ?? "—"}
          </dd>
        </div>
      </dl>
    </article>
  );
}
