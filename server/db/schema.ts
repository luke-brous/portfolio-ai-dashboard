import {
  sqliteTable,
  text,
  integer,
  real,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";

export const nonprofits = sqliteTable("nonprofits", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  name: text("name").notNull(),

  contactEmail: text("contact_email"),
  grantCycleDates: text("grant_cycle_dates"),
  grantAmount: real("grant_amount"),
  grantStatus: text("grant_status"),
});

export const reports = sqliteTable("reports", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  // Foreign key to the nonprofits table
  nonprofitId: integer("nonprofit_id")
    .references(() => nonprofits.id)
    .notNull(),

  messageId: text("message_id").notNull().unique(),
  summary: text("summary").notNull(),

  date: integer("date", { mode: "timestamp" }).notNull(),
});

export const investments = sqliteTable("investments", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  ticker: text("ticker").notNull().unique(),
  companyName: text("company_name").notNull(),
  sector: text("sector"),

  shares: real("shares").notNull(),
  percentOfAccount: real("percent_of_account"),
});

export const priceSnapshots = sqliteTable("price_snapshots", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  investmentId: integer("investment_id")
    .references(() => investments.id)
    .notNull(),
  price: real("price").notNull(),
  change: real("change"),
  percentChange: real("percent_change"),
  high: real("high"),
  low: real("low"),
  open: real("open"),
  prevClose: real("prev_close"),
  timestamp: integer("timestamp", { mode: "timestamp" }).notNull(),
});

// Durable record of every scheduled Finnhub sync tick.
//
// The in-memory `lastSyncRun` in server/lib/syncState.ts is dropped by any
// restart — deploy, crash, `bun --watch` picking up a save — which is what
// made the dashboard badge fall back to "Not synced yet" while the data in
// price_snapshots was in fact minutes old. Persisting the outcome here lets
// GET /portfolio/sync-status answer honestly across a restart.
export const syncRuns = sqliteTable("sync_runs", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  at: integer("at", { mode: "timestamp" }).notNull(),
  ok: integer("ok", { mode: "boolean" }).notNull(),
  note: text("note").notNull(),
  tickersProcessed: integer("tickers_processed").notNull().default(0),
  tickersSkipped: integer("tickers_skipped").notNull().default(0),
  tickersFailed: integer("tickers_failed").notNull().default(0),
});

export const newsItems = sqliteTable(
  "news_items",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    investmentId: integer("investment_id")
      .references(() => investments.id)
      .notNull(),
    newsCategory: text("news_category"),
    headline: text("headline").notNull(),
    finnhubId: integer("finnhub_id").notNull(),
    source: text("source"),
    summary: text("summary"),
    url: text("url"),
    timestamp: integer("timestamp", { mode: "timestamp" }).notNull(),
  },
  (t) => ({
    // One Finnhub news article (finnhub_id) can mention multiple held tickers.
    // The dedup boundary needs to be (finnhub_id, investment_id), not
    // finnhub_id alone, so each ticker can record its own copy of the article.
    // INSERT OR IGNORE in syncMarketData.ts dedupes per pair automatically.
    finnhubInvestmentIdx: uniqueIndex("news_finnhub_investment_idx").on(
      t.finnhubId,
      t.investmentId,
    ),
  }),
);
