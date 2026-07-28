import useNonProfits from "../hooks/useNonProfits";
import CrmCard from "../components/CrmCard";
import CrmSkeleton from "../components/CrmSkeleton";

export default function CRM() {
  const { data, isPending, isError, error } = useNonProfits();
  const nonprofits = data?.nonprofits ?? [];
  const count = data?.count ?? 0;
  const total = data?.total ?? 0;

  return (
    <section className="max-w-4xl mx-auto px-6 py-12 md:py-16">
      <header className="mb-10">
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
      </header>

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
            <CrmCard key={np.id} nonprofit={np} />
          ))}
        </div>
      )}
    </section>
  );
}
