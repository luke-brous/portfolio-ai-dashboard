import { useState, useEffect } from "react";
import { useQueryClient } from "@tanstack/react-query";
import LabelPicker from "../components/LabelPicker";
import DateRangePicker from "../components/DateRangePicker";
import SummaryCard from "../components/SummaryCard";
import type { Summary } from "../types/index"
import ExportButton from "../components/ExportButton";
import { EmailCardSkeleton } from "../components/EmailCardSkeleton";
import { useEmails } from "../hooks/useEmails";
import { useAuth } from "../hooks/useAuth";
import { useSummarizeMutation } from "../hooks/useSummarize";

export default function Dashboard() {
  const [label, setLabel] = useState<string | null>(null);
  const [dateRange, setDateRange] = useState<{ after: string; before: string } | null>(null);

  const queryClient = useQueryClient();
  const { data: authData, isLoading: authLoading } = useAuth();

  useEffect(() => {
  if (!authLoading && !authData?.isAuthed) {
    const backendURL = import.meta.env.VITE_BACKEND_URL;
    window.location.href = `${backendURL}/auth/login`;
  }
}, [authData, authLoading]);

  // pass label + dateRange into useEmails to fetch
  const { refetch: fetchEmails } = useEmails(label, dateRange);
  const { mutateAsync: summarize, data: summaries = [], isPending: isSummarizing } = useSummarizeMutation();

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

  if (authLoading) return <div className="p-8">Loading session...</div>;
  if (!authData?.isAuthed) return null;

  const handleLogout = () => {
    // Nuke cached data before redirecting 
    queryClient.clear();
    
    const backendURL = import.meta.env.VITE_BACKEND_URL;
    
    // destroy the cookie by routing user to backend logout endpoint
    window.location.href = `${backendURL}/auth/logout`;
  };

  return (
    // Same tinted background and font as the login page
    <div className="min-h-screen bg-slate-50 text-slate-900 font-['Outfit'] selection:bg-indigo-100 selection:text-indigo-900">
      
      {/* Navbar (Matches Login) */}
      <nav className="w-full py-6 px-8 md:px-16 flex justify-between items-center border-b border-slate-200 bg-slate-50/80 backdrop-blur-md sticky top-0 z-10">
        <div className="text-xl font-bold tracking-tight text-indigo-950">
          Mail Brief
        </div>
        <div className="flex gap-8 text-sm font-medium text-slate-600">
          <span className="text-indigo-600 cursor-default">Dashboard</span>
          <button 
            onClick={handleLogout} 
            className="hover:text-indigo-600 transition-colors duration-300 ease-in-out"
          >
            Logout
          </button>
        </div>
      </nav>

      {/* Main Dashboard Layout */}
      <main className="max-w-5xl mx-auto px-6 py-12 md:py-16">
        
        <header className="mb-10">
          <h1 className="text-3xl md:text-4xl font-bold text-indigo-950 tracking-tight mb-3">
            Inbox Overview
          </h1>
          <p className="text-lg text-slate-600 font-light">
            Filter by label and date to generate your AI briefing.
          </p>
        </header>

        {/* Control Bar: No cards here, just a clean row of inputs separated by a border */}
        <section className="flex flex-col md:flex-row gap-6 items-end mb-12 pb-8 border-b border-slate-200">
          <div className="w-full md:w-auto flex-1 max-w-xs">
            <label className="block text-sm font-medium text-slate-600 mb-2">Select Label</label>
            <LabelPicker value={label} onChange={setLabel} />
          </div>
          
          <div className="w-full md:w-auto flex-1 max-w-md">
            <label className="block text-sm font-medium text-slate-600 mb-2">Date Range</label>
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
            <ExportButton disabled={summaries.length === 0} />
          </div>
        </section>

        {/* Results Area */}
        <section className="space-y-6">
          
          {/* Smooth, pulsing loading state */}
          {isSummarizing && (
            <div className="space-y-4">
              <EmailCardSkeleton />
              <EmailCardSkeleton />
              <EmailCardSkeleton />
            </div>
          )}

          {/* Empty State */}
          {!isSummarizing && summaries.length === 0 && label && dateRange && (
            <div className="py-12 text-slate-500 font-light text-lg">
              No emails found matching your criteria. Try adjusting the date range.
            </div>
          )}

          {/* The Summary Cards */}
          <div className="grid grid-cols-1 gap-6">
            {summaries.map((s: Summary) => (
              <SummaryCard key={s.id} summary={s} />
            ))}
          </div>

        </section>
      </main>
    </div>
  );
}
