import type { NewsItem } from "../types";

function formatRelative(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const diffMs = Date.now() - d.getTime();
  const min = Math.max(0, Math.floor(diffMs / 60_000));
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.floor(hr / 24);
  if (day < 7) return `${day}d ago`;
  return d.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
  });
}

export default function NewsCard({ item }: { item: NewsItem }) {
  // If there's a source URL, render as a link; otherwise as a plain card.
  const linkProps: { href: string; target: "_blank"; rel: string } | object =
    item.url
      ? {
          href: item.url,
          target: "_blank",
          rel: "noopener noreferrer",
        }
      : {};
  const isLink = "href" in linkProps;
  const Tag = isLink ? "a" : "div";

  return (
    <Tag
      {...linkProps}
      className={`block px-5 py-4 bg-white border border-slate-200 rounded-lg ${
        isLink
          ? "hover:border-indigo-300 hover:shadow-sm transition-all duration-200"
          : ""
      }`}
    >
      <div className="flex items-center gap-3 mb-1">
        <span className="text-xs font-semibold tracking-wide text-indigo-700 bg-indigo-50 rounded px-2 py-0.5">
          {item.ticker}
        </span>
        {item.source && (
          <span className="text-xs text-slate-400">· {item.source}</span>
        )}
        {item.category && (
          <span className="text-xs text-slate-400 font-light">
            · {item.category}
          </span>
        )}
        <span className="ml-auto text-xs text-slate-400 font-light tabular-nums">
          {formatRelative(item.timestamp)}
        </span>
      </div>
      <p className="text-sm text-slate-700 font-light leading-relaxed">
        {item.headline}
      </p>
      {item.summary && (
        <p className="mt-2 text-xs text-slate-500 font-light line-clamp-2">
          {item.summary}
        </p>
      )}
    </Tag>
  );
}
