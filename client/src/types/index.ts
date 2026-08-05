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

/** Outcome of a completed correspondence sync run. */
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

/**
 * 202 acknowledgement from POST /crm/nonprofits/:id/sync.
 *
 * The sync runs in the background — a request that waited for the result was
 * long enough for the proxy to kill it, which surfaced in the browser as a
 * CORS error. Poll `GET /crm/nonprofits/:id/sync-status` for the outcome.
 */
export interface SyncCorrespondenceAck {
  nonprofitId: number;
  status: "running";
  /** True when a run was already in flight, so this click started nothing. */
  alreadyRunning: boolean;
}

export type CrmSyncStatus = "idle" | "running" | "done" | "error";

/** Response of GET /crm/nonprofits/:id/sync-status. */
export interface CrmSyncJob {
  nonprofitId: number;
  status: CrmSyncStatus;
  /** ISO string, or null when no run has happened in this server process. */
  startedAt: string | null;
  finishedAt: string | null;
  /** Populated only when `status === "done"`. */
  result: SyncCorrespondenceResult | null;
  /**
   * Populated only when `status === "error"`. `status` here is the HTTP code
   * the failure would have carried inline — 401 sign in again, 422 fix the
   * label, 502 Gmail unreachable.
   */
  error: { message: string; status: number } | null;
}
