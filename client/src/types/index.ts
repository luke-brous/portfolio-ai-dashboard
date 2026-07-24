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
  delta: number | null;
}

export interface InvestmentwithSnapshot extends Investment {
  latestSnapshot: InvestmentSnapshot | null;
  previousSnapshot: InvestmentSnapshot | null;
  delta: number | null;
}
