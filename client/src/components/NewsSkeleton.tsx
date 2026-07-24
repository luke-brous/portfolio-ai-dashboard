import { Skeleton } from "./Skeleton";

export default function NewsSkeleton({ rows = 3 }: { rows?: number }) {
  return (
    <div
      className="space-y-3"
      role="status"
      aria-busy="true"
      aria-label="Loading news"
    >
      {Array.from({ length: rows }).map((_, i) => (
        <div
          key={i}
          className="px-5 py-4 bg-white border border-slate-200 rounded-lg space-y-2"
        >
          <div className="flex items-center gap-3">
            <Skeleton className="h-4 w-12" />
            <Skeleton className="h-3 w-24" />
            <div className="ml-auto">
              <Skeleton className="h-3 w-16" />
            </div>
          </div>
          <Skeleton className="h-3 w-full" />
          <Skeleton className="h-3 w-4/5" />
        </div>
      ))}
    </div>
  );
}
