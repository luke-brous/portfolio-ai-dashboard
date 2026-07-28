export default function CrmSkeleton() {
  // 10 placeholder cards matching CrmCard's footprint. Approximates a
  // typical seed (~11 nonprofits) so the layout doesn't jump when the
  // real data lands.
  const rows = Array.from({ length: 10 });

  return (
    <div
      role="status"
      aria-label="Loading nonprofits"
      className="grid gap-4 animate-pulse"
    >
      {rows.map((_, i) => (
        <div
          key={i}
          className="rounded-xl border border-slate-200 bg-white px-6 py-5"
        >
          <div className="flex items-start justify-between gap-4">
            <div className="flex-1 space-y-2">
              <div className="h-5 w-1/3 rounded bg-slate-200" />
              <div className="h-4 w-1/4 rounded bg-slate-100" />
            </div>
            <div className="h-5 w-16 rounded-full bg-slate-100" />
          </div>
          <div className="mt-4 grid grid-cols-2 gap-x-6 gap-y-2">
            <div className="h-4 w-1/2 rounded bg-slate-100" />
            <div className="h-4 w-1/2 rounded bg-slate-100" />
          </div>
        </div>
      ))}
    </div>
  );
}
