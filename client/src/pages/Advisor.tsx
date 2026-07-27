import AdvisorSkeleton from "../components/AdvisorSkeleton";
import NewsCard from "../components/NewsCard";
import NewsSkeleton from "../components/NewsSkeleton";
import InvestmentRow from "../components/InvestmentRow";
import SyncBadge from "../components/SyncBadge";
import { useInvestments } from "../hooks/useInvestments";
import { useNews } from "../hooks/useNews";

export default function Advisor() {
  const { investments, isLoading, isError } = useInvestments();
  const { news, isLoading: newsLoading, isError: newsError } = useNews(7);

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

      {/* Holdings List */}
      <section className="space-y-3">
        <h2 className="text-xs uppercase tracking-widest font-semibold text-slate-500 mb-4">
          Holdings ({investments.length})
        </h2>
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
            <InvestmentRow key={investment.id} investment={investment} />
          ))
        )}
      </section>
    </section>
  );
}
