import { useState } from "react";
import LabelPicker from "../components/LabelPicker";
import DateRangePicker from "../components/DateRangePicker";
import SummaryCard from "../components/SummaryCard";
import type { Summary } from "../types/index";
import { EmailCardSkeleton } from "../components/EmailCardSkeleton";
import { useEmails } from "../hooks/useEmails";
import { useSummarizeMutation } from "../hooks/useSummarize";

export default function Mailbrief() {
  const [label, setLabel] = useState<string | null>(null);
  const [dateRange, setDateRange] = useState<{
    after: string;
    before: string;
  } | null>(null);

  const { refetch: fetchEmails } = useEmails(label, dateRange);
  const {
    mutateAsync: summarize,
    data: summaries = [],
    isPending: isSummarizing,
  } = useSummarizeMutation();

  const handleGenerateBrief = async () => {
    if (!label || !dateRange?.after || !dateRange?.before) {
      alert("Please select a label and a valid date range.");
      return;
    }
    const { data: emails } = await fetchEmails();
    if (!emails || emails.length === 0) {
      alert("No emails found.");
      return;
    }
    await summarize({ emails });
  };

  return (
    <section className="max-w-5xl mx-auto px-6 py-12 md:py-16">
      <header className="mb-10">
        <h1 className="text-3xl md:text-4xl font-bold text-indigo-950 tracking-tight mb-3">
          Inbox Overview
        </h1>
        <p className="text-lg text-slate-600 font-light">
          Filter by label and date to generate your AI briefing.
        </p>
      </header>

      <section className="flex flex-col md:flex-row gap-6 items-end mb-12 pb-8 border-b border-slate-200">
        <div className="w-full md:w-auto flex-1 max-w-xs">
          <label className="block text-sm font-medium text-slate-600 mb-2">
            Select Label
          </label>
          <LabelPicker value={label} onChange={setLabel} />
        </div>
        <div className="w-full md:w-auto flex-1 max-w-md">
          <label className="block text-sm font-medium text-slate-600 mb-2">
            Date Range
          </label>
          <DateRangePicker value={dateRange} onChange={setDateRange} />
        </div>
        <div className="w-full md:w-auto flex gap-4">
          <button
            onClick={handleGenerateBrief}
            disabled={isSummarizing}
            className="bg-indigo-600 hover:bg-indigo-700 text-white font-medium px-6 py-3 rounded-lg transition-colors duration-300 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {isSummarizing ? "Analyzing..." : "Generate Brief"}
          </button>
        </div>
      </section>

      <section className="space-y-6">
        {isSummarizing && (
          <div className="space-y-4">
            <EmailCardSkeleton />
            <EmailCardSkeleton />
            <EmailCardSkeleton />
          </div>
        )}
        {!isSummarizing && summaries.length === 0 && label && dateRange && (
          <div className="py-12 text-slate-500 font-light text-lg">
            No emails found matching your criteria. Try adjusting the date
            range.
          </div>
        )}
        <div className="grid grid-cols-1 gap-6">
          {summaries.map((s: Summary) => (
            <SummaryCard key={s.id} summary={s} />
          ))}
        </div>
      </section>
    </section>
  );
}
