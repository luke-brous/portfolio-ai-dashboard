import { Skeleton } from "./Skeleton";

export function EmailCardSkeleton() {
  return (
    <div className="border border-slate-200 rounded-lg p-4 mb-3 bg-white">
      <Skeleton className="h-5 w-1/3 mb-2" />
      <Skeleton className="h-4 w-1/2 mb-4" />
      <Skeleton className="h-4 w-full mb-2" />
      <Skeleton className="h-4 w-full" />
    </div>
  );
}
