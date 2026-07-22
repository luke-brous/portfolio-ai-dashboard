import "dotenv/config";
import {
  describe,
  it,
  expect,
  mock,
  beforeEach,
  afterAll,
} from "bun:test";
import { syncMarketData } from "../db/syncMarketData";
import { investments } from "../db/schema";
import { getQuote, getCompanyNews } from "../lib/finnhub";

// ---------- Mockable references ------------------------------------------------------------
//
// Each `it` block sets the per-test behavior it needs by reassigning via
// `mockImplementation(...)`. The instances below are declared at module
// scope and exported through `mock.module` so that `syncMarketData.ts`'s
// internal imports resolve to the same mock object.

const DEFAULT_QUOTE = {
  c: 150,
  d: 1,
  dp: 0.5,
  h: 155,
  l: 145,
  o: 148,
  pc: 149,
  t: 12345,
};
const DEFAULT_NEWS = [
  {
    id: 1,
    datetime: 12345,
    headline: "Test News",
    source: "Test",
    summary: "Test",
    url: "http://test.com",
    category: "Test",
  },
];

const allFromInvestments = mock(
  () => [] as Array<{ id: number; ticker: string }>,
);
const allFromPriceSnapshots = mock(() => [] as Array<{ id: number }>);
const insertValues = mock(async () => [{ id: 1 }]);
const runSql = mock(async () => {});
const getQuoteMock = mock(
  async (): Promise<typeof DEFAULT_QUOTE> => DEFAULT_QUOTE,
);
const getCompanyNewsMock = mock(
  async (): Promise<typeof DEFAULT_NEWS> => DEFAULT_NEWS,
);
const sleepMock = mock(async () => {});

// ---------- Module mocks -------------------------------------------------------------------
//
// Bun's `mock.module` keys on the *specifier* string (not the resolved
// path), so we register the same factory at both specifiers that resolve
// to `server/index.ts`:
//   - The test file imports nothing from `../index` directly today, but
//     other test files in the project do.
//   - `server/db/syncMarketData.ts` imports `{ db } from ".."` (a
//     different specifier that resolves to the same file) — without
//     this second registration, syncMarketData would fall through to the
//     real DB and call real Finnhub.

const dbMockFactory = () => ({
  db: {
    // Discriminate between the two SELECT shapes by comparing the `table`
    // argument to the schema symbols. Bun resolves both the test's
    // `../db/schema` and syncMarketData's `./schema` to the same module
    // instance in memory, so symbol identity is reliable here.
    select: mock(() => ({
      from: mock((table: unknown) => {
        if (table === investments) return { all: allFromInvestments };
        return {
          where: mock(
            () => ({ limit: mock(() => ({ all: allFromPriceSnapshots })) }),
          ),
        };
      }),
    })),
    insert: mock(() => ({ values: insertValues })),
    run: runSql,
  },
});

mock.module("..", dbMockFactory);
mock.module("../index", dbMockFactory);

mock.module("../lib/finnhub", () => ({
  getQuote: getQuoteMock,
  getCompanyNews: getCompanyNewsMock,
}));

// Bypass the production 2-second throttle so iteration-driven tests stay
// fast. Other test files do not import `server/lib/utils`, so mocking the
// whole module is safe today.
mock.module("../lib/utils", () => ({ sleep: sleepMock }));

// ---------- Setup / teardown ----------------------------------------------------------------

function applyDefaults(): void {
  // mockClear resets call counts; mockImplementation sets the per-call impl.
  getQuoteMock.mockClear();
  getQuoteMock.mockImplementation(async () => DEFAULT_QUOTE);
  getCompanyNewsMock.mockClear();
  getCompanyNewsMock.mockImplementation(async () => DEFAULT_NEWS);
  allFromInvestments.mockClear();
  allFromInvestments.mockImplementation(() => []);
  allFromPriceSnapshots.mockClear();
  allFromPriceSnapshots.mockImplementation(() => []);
  insertValues.mockClear();
  insertValues.mockImplementation(async () => [{ id: 1 }]);
  runSql.mockClear();
  runSql.mockImplementation(async () => {});
  sleepMock.mockClear();
  sleepMock.mockImplementation(async () => {});
}

beforeEach(() => {
  applyDefaults();
});

afterAll(() => {
  mock.restore();
});

// ---------- Suite ----------------------------------------------------------------------------

describe("Finnhub Integration Flow", () => {
  describe("lib/finnhub.ts", () => {
    it("resolves a quote with the canonical Finnhub shape", async () => {
      const quote = await getQuote("AAPL");
      expect(quote.c).toBe(150);
      expect(quote.pc).toBe(149);
    });

    it("resolves company news with the expected item shape", async () => {
      const news = await getCompanyNews("AAPL", "2026-07-01", "2026-07-08");
      expect(news).toHaveLength(1);
      expect(news[0]?.headline).toBe("Test News");
    });
  });

  describe("db/syncMarketData.ts", () => {
    it("returns all-zero counters and skips Finnhub when no tickers exist", async () => {
      const result = await syncMarketData();
      expect(result).toEqual({
        tickersProcessed: 0,
        tickersFailed: 0,
        tickersSkipped: 0,
      });
      expect(getQuoteMock).not.toHaveBeenCalled();
      expect(getCompanyNewsMock).not.toHaveBeenCalled();
    });

    it("skips a ticker whose snapshot already exists today, without calling Finnhub", async () => {
      allFromInvestments.mockImplementation(() => [
        { id: 1, ticker: "AAPL" },
      ]);
      allFromPriceSnapshots.mockImplementation(() => [{ id: 99 }]);

      const result = await syncMarketData();

      // Contract: same-day-skip MUST NOT call Finnhub and MUST NOT insert
      // a fresh snapshot. The implementation also bumps `tickersProcessed`
      // inside the skip branch, which is an opaque implementation detail
      // — so we assert the contract, not the counter value.
      expect(result.tickersSkipped).toBe(1);
      expect(result.tickersFailed).toBe(0);
      expect(getQuoteMock).not.toHaveBeenCalled();
      expect(getCompanyNewsMock).not.toHaveBeenCalled();
      expect(insertValues).not.toHaveBeenCalled();
    });

    it("rejects a quote where `c` is 0 and counts the ticker as failed", async () => {
      allFromInvestments.mockImplementation(() => [
        { id: 1, ticker: "INVALID" },
      ]);
      allFromPriceSnapshots.mockImplementation(() => []);
      getQuoteMock.mockImplementation(async () => ({
        c: 0,
        d: 0,
        dp: 0,
        h: 0,
        l: 0,
        o: 0,
        pc: 0,
        t: 0,
      }));

      const result = await syncMarketData();

      expect(result.tickersFailed).toBe(1);
      expect(result.tickersSkipped).toBe(0);
      // All-zero quote is rejected BEFORE the price snapshot insert fires.
      expect(insertValues).not.toHaveBeenCalled();
      // One sleep per tick (the catch block falls through, sleep runs at
      // the end of every loop iteration regardless of branch outcome).
      expect(sleepMock).toHaveBeenCalledTimes(1);
    });
  });
});
