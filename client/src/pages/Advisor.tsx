import { useState } from "react";
import AdvisorSkeleton from "../components/AdvisorSkeleton";
import NewsCard from "../components/NewsCard";
import NewsSkeleton from "../components/NewsSkeleton";
import InvestmentRow from "../components/InvestmentRow";
import InvestmentForm from "../components/InvestmentForm";
import SyncBadge from "../components/SyncBadge";
import {
  useDeleteInvestment,
  useInvestments,
} from "../hooks/useInvestments";
import { useNews } from "../hooks/useNews";
import type { Investment } from "../types";

export default function Advisor() {
  const { investments, isLoading, isError } = useInvestments();
  const { news, isLoading: newsLoading, isError: newsError } = useNews(7);
  const del = useDeleteInvestment();

  // Track which row's delete is in flight so only that row's button
  // shows the disabled state when multiple rows exist.
  const [pendingDeleteId, setPendingDeleteId] = useState<number | null>(null);
  // "Add holding" toggle at the top of the Holdings section. Closed by
  // default so the page is calmer; clicking opens the form just below
  // the section heading, above the holdings list. The form closes
  // itself after a successful submit via `onDone`.
  const [showForm, setShowForm] = useState(false);

  const handleDelete = async (investment: Investment) => {
    // native window.confirm is acceptable for the MVP scope per spec —
    // no custom modal. Confirmation copy mentions the ticker so the
    // user doesn't have to scan the dialog to recognise the row.
    const ok = window.confirm(
      `Delete ${investment.ticker} (${investment.companyName})? This permanently removes price snapshots and news for this holding.`,
    );
    if (!ok) return;
    setPendingDeleteId(investment.id);
    try {
      await del.mutateAsync(investment.id);
    } finally {
      // Guarded reset: if *another* delete was launched while this one
      // was in flight, the second handler's setPendingDeleteId has
      // already overwritten ours. Don't clobber it back to null on
      // our way out — only clear when we're still the current owner.
      setPendingDeleteId((cur) => (cur === investment.id ? null : cur));
    }
  };

  return (
    <section className="max-w-5xl mx-auto px-6 py-12 md:py-16">
      <header className="mb-10 flex flex-col sm:flex-row sm:items-start sm:justify-between gap-4">
        <div>
          <h1 className="text-3xl md:text-4xl font-bold text-indigo-950 tracking-tight mb-3">
            Portfolio Advisor
          </h1>
          <p className="text-lg text-slate-600 font-light">
            Live holdings, latest price, and change since the previous sync.
          </p>
        </div>
        <div className="sm:pt-2">
          <SyncBadge />
        </div>
      </header>

      {/* News Feed */}
      <section className="mb-12">
        <h2 className="text-xs uppercase tracking-widest font-semibold text-slate-500 mb-4">
          Recent Headlines
        </h2>
        {newsLoading ? (
          <NewsSkeleton />
        ) : newsError ? (
          <div className="py-8 text-center text-red-600 font-light">
            Couldn't load news feed.
          </div>
        ) : news.length === 0 ? (
          <div className="py-8 text-center text-slate-500 font-light">
            No recent news.
          </div>
        ) : (
          <div className="space-y-3">
            {news.slice(0, 10).map((item) => (
              <NewsCard key={item.id} item={item} />
            ))}
          </div>
        )}
      </section>

      {/* Holdings List — with an "Add holding" toggle at the top of the
         section. The form (when open) is rendered between the section
         heading and the list, so creating a new holding is anchored to
         the holdings context rather than a separate page-bottom block. */}
      <section className="space-y-3 mb-10">
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-xs uppercase tracking-widest font-semibold text-slate-500">
            Holdings ({investments.length})
          </h2>
          <button
            type="button"
            onClick={() => setShowForm((v) => !v)}
            aria-expanded={showForm}
            aria-controls="add-holding-form"
            className="rounded-md bg-indigo-600 px-3 py-2 text-sm font-semibold text-white shadow-sm transition-colors duration-200 hover:bg-indigo-700"
          >
            {showForm ? "Close" : "Add holding"}
          </button>
        </div>

        {showForm && (
          <div id="add-holding-form" className="mb-4">
            <InvestmentForm onDone={() => setShowForm(false)} />
          </div>
        )}

        {isLoading ? (
          <AdvisorSkeleton />
        ) : isError ? (
          <div className="py-16 text-center text-red-600 font-light text-lg">
            Couldn't load investments. Please retry shortly.
          </div>
        ) : investments.length === 0 ? (
          <div className="py-16 text-center text-slate-500 font-light text-lg">
            No investments yet.
          </div>
        ) : (
          investments.map((investment) => (
            <InvestmentRow
              key={investment.id}
              investment={investment}
              onDelete={() => void handleDelete(investment)}
              isDeleting={pendingDeleteId === investment.id}
            />
          ))
        )}
      </section>
    </section>
  );
}
