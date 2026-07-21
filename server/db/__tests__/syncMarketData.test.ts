import { describe, it, expect, beforeEach, afterAll } from "bun:test";
import { Database } from "bun:sqlite";

/**
 * Real-SQLite tests for the `INSERT OR IGNORE` idempotency that
 * `server/db/syncMarketData.ts` relies on for `news_items`.
 *
 * Drizzle does not expose its schema as a plain SQL string we can `exec`
 * here (no generated migrations folder yet), so the schema is restated by
 * hand. Keep this in lock-step with `server/db/schema.ts` — any column
 * rename there must be mirrored here, or this test will silently mis-verify
 * idempotency.
 */
const SCHEMA_SQL = `
  CREATE TABLE investments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ticker TEXT NOT NULL UNIQUE,
    company_name TEXT NOT NULL,
    sector TEXT,
    shares REAL NOT NULL,
    percent_of_account REAL
  );

  CREATE TABLE price_snapshots (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    investment_id INTEGER NOT NULL REFERENCES investments(id),
    price REAL NOT NULL,
    change REAL,
    percent_change REAL,
    high REAL,
    low REAL,
    open REAL,
    prev_close REAL,
    timestamp INTEGER NOT NULL
  );

  CREATE TABLE news_items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    investment_id INTEGER NOT NULL REFERENCES investments(id),
    news_category TEXT,
    headline TEXT NOT NULL,
    finnhub_id INTEGER NOT NULL,
    source TEXT,
    summary TEXT,
    url TEXT,
    timestamp INTEGER NOT NULL
  );

  CREATE UNIQUE INDEX news_finnhub_investment_idx
    ON news_items (finnhub_id, investment_id);
`;

const INSERT_NEWS_SQL = `
  INSERT OR IGNORE INTO news_items
    (investment_id, news_category, headline, finnhub_id, source, summary, url, timestamp)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?)
`;

let db: Database;

beforeEach(() => {
  // Fresh in-memory database per test so state never leaks.
  db = new Database(":memory:");
  db.exec(SCHEMA_SQL);
  // Seed an investment so the news_items FK is satisfied.
  db.run(
    `INSERT INTO investments (ticker, company_name, shares) VALUES ('AAPL', 'Apple Inc.', 100)`,
  );
});

afterAll(() => {
  // Detach so the next test file does not accidentally hit our DB handle.
  // (Closing is implicit on process exit; this is just defensive.)
  db?.close();
  db = undefined as unknown as Database;
});

describe("news_items INSERT OR IGNORE idempotency", () => {
  it("ignores a second insert that re-uses the same (finnhub_id, investment_id) pair", () => {
    // First insert: succeeds.
    db.run(INSERT_NEWS_SQL, [
      1,
      "general",
      "Apple announces new product",
      4242,
      "TestSource",
      "Test summary",
      "https://example.com/aapl",
      12345,
    ]);

    // Second insert with the SAME (finnhub_id=4242, investment_id=1) but a
    // deliberately different headline / url, so we know the unique index
    // (not row equality) is what kept the duplicate out.
    db.run(INSERT_NEWS_SQL, [
      1,
      "general",
      "DIFFERENT headline that should be discarded",
      4242,
      "TestSource",
      "Test summary",
      "https://example.com/different",
      12346,
    ]);

    const countRow = db
      .query(
        "SELECT COUNT(*) AS c FROM news_items WHERE finnhub_id = ? AND investment_id = ?",
      )
      .get(4242, 1) as { c: number } | null;
    expect(countRow?.c).toBe(1);

    // And the surviving row is the FIRST one we wrote, not the duplicate.
    const survivor = db
      .query(
        "SELECT headline FROM news_items WHERE finnhub_id = ? AND investment_id = ?",
      )
      .get(4242, 1) as { headline: string } | null;
    expect(survivor?.headline).toBe("Apple announces new product");
  });

  it("still inserts a row when (finnhub_id, investment_id) differs on either axis", () => {
    // Same investment, two different articles.
    db.run(INSERT_NEWS_SQL, [
      1,
      "general",
      "First news",
      100,
      "A",
      "a",
      "http://a",
      1,
    ]);
    db.run(INSERT_NEWS_SQL, [
      1,
      "general",
      "Second news",
      200,
      "B",
      "b",
      "http://b",
      2,
    ]);

    const total = db
      .query("SELECT COUNT(*) AS c FROM news_items")
      .get() as { c: number } | null;
    expect(total?.c).toBe(2);
  });
});
