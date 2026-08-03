export interface Email {
  id: string;
  from: string;
  subject: string;
  body: string;
  date: string;
}

export interface Label {
  id: string;
  name: string;
}

export interface Summary {
  id: string;
  from: string;
  subject: string;
  date: string;
  summary: string;
}

export interface InvestmentSnapshot {
  price: number;
  timestamp: string;
}

export interface NewsItem {
  id: number;
  ticker: string;
  headline: string;
  source: string | null;
  summary: string | null;
  url: string | null;
  category: string | null;
  timestamp: string;
}

export interface NewsResponse {
  ticker: string | null;
  days: number;
  count: number;
  news: NewsItem[];
}

export interface Investment {
  id: string;
  ticker: string;
  companyName: string;
  sector: string;
  shares: number;
  percentOfAccount: number;
  latestSnapshot: InvestmentSnapshot | null;
  previousSnapshot: InvestmentSnapshot | null;
  delta: {
    price: number | null;
    percentChange: number | null;
  } | null;
}

export interface InvestmentwithSnapshot extends Investment {
  latestSnapshot: InvestmentSnapshot | null;
  previousSnapshot: InvestmentSnapshot | null;
  delta: Investment["delta"];
}

export interface Nonprofit {
  id: number;
  name: string;
  contactEmail: string | null;
  grantCycleDates: string | null;
  grantAmount: number | null;
  grantStatus: string | null;
}

/** One piece of recorded correspondence: a Gemini summary of one email. */
export interface Report {
  id: number;
  nonprofitId: number;
  messageId: string;
  summary: string;
  /** ISO string — the server serialises the timestamp column explicitly. */
  date: string;
}

export interface ReportsResponse {
  nonprofitId: number;
  count: number;
  total: number;
  limit: number;
  offset: number;
  reports: Report[];
}

/** Outcome of POST /crm/nonprofits/:id/sync. */
export interface SyncCorrespondenceResult {
  nonprofitId: number;
  /** Gmail hits from this sender in the window, before dedup. */
  matched: number;
  /** Already stored, so never sent to Gemini. */
  skipped: number;
  summarized: number;
  failed: number;
  /** Unseen mail remained beyond this run's cap — another sync will get it. */
  hasMore: boolean;
}
