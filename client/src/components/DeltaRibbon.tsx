type Props = {
  /** Signed dollar delta (e.g. +12.34 or -12.34). Null = unknown. */
  dollarDelta: number | null;
  /** Signed percent delta (e.g. +3.45 or -3.45). Null = unknown. */
  percentDelta: number | null;
};

function formatDollar(n: number): string {
  const sign = n > 0 ? "+" : n < 0 ? "-" : "";
  const formatted = Math.abs(n).toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
  return `${sign}$${formatted}`;
}

function formatPercent(n: number): string {
  const sign = n > 0 ? "+" : n < 0 ? "-" : "";
  const abs = Math.abs(n);
  const formatted = abs >= 100 ? abs.toFixed(0) : abs.toFixed(2);
  return `${sign}${formatted}%`;
}

export default function DeltaRibbon({ dollarDelta, percentDelta }: Props) {
  const hasData = dollarDelta !== null && percentDelta !== null;
  const positive = hasData && (dollarDelta as number) > 0;
  const negative = hasData && (dollarDelta as number) < 0;

  const tone = positive
    ? "bg-emerald-50 text-emerald-700 ring-emerald-200"
    : negative
      ? "bg-red-50 text-red-700 ring-red-200"
      : "bg-slate-100 text-slate-500 ring-slate-200";

  return (
    <span
      className={`inline-flex items-center gap-1 px-2 py-0.5 text-xs font-medium rounded-full ring-1 ${tone}`}
    >
      <span>{hasData ? formatDollar(dollarDelta as number) : "—"}</span>
      <span className="opacity-60">·</span>
      <span>{hasData ? formatPercent(percentDelta as number) : "—"}</span>
    </span>
  );
}
