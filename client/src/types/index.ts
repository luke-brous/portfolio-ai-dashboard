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

export interface Report {
  id: number;
  nonprofitId: number;
  messageId: string;
  summary: string;
  date: string;
}

export interface GenerateReportResponse {
  nonprofitId: number;
  fetched: number; // gmail matches
  persisted: number; // new rows in reports table
  summaries: Array<{
    messageId: string;
    from: string;
    subject: string;
    date: string;
    summary: string;
  }>;
}
