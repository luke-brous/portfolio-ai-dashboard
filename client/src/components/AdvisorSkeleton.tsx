import { Skeleton } from "./Skeleton";

export default function AdvisorSkeleton({ rows = 5 }: { rows?: number }) {
  return (
    <div
      className="space-y-3"
      role="status"
      aria-busy="true"
      aria-label="Loading investments"
    >
      {Array.from({ length: rows }).map((_, i) => (
        <div
          key={i}
          className="flex items-center gap-6 px-5 py-4 bg-white border border-slate-200 rounded-lg"
        >
          <div className="min-w-0 flex-1 space-y-2">
            <Skeleton className="h-4 w-16" />
            <Skeleton className="h-3 w-40" />
          </div>
          <div className="flex flex-col items-end gap-2">
            <Skeleton className="h-4 w-24" />
            <Skeleton className="h-4 w-32" />
          </div>
          <div className="hidden sm:block w-40">
            <Skeleton className="h-3 w-full" />
          </div>
        </div>
      ))}
    </div>
  );
}
