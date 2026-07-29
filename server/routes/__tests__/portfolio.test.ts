import { describe, it, expect, mock, beforeEach, afterAll } from "bun:test";
import { getCookie } from "hono/cookie";
import type { Context, Next } from "hono";
import crypto from "crypto";
import * as drizzleOrm from "drizzle-orm";
import portfolio from "../portfolio";
import { investments, priceSnapshots, newsItems } from "../../db/schema";
import {
  recordSyncFinish,
  recordSyncRun,
  recordSyncStart,
} from "../../lib/syncState";
import { createSession } from "../../lib/session";
import type { SessionData } from "../../types/session";

// ---------- Module mocks ------------------------------------------------------------
//
// `server/routes/portfolio.ts` imports `{ db } from "../db/client"` — the
// DAG-preserving path documented in server/db/client.ts. We mock that exact
// module here (resolved from this test file as `../../db/client`), so the
// production route never touches a real SQLite connection.

// ---------- drizzle-orm mock --------------------------------------------------------
//
// Production calls `eq(investments.id, X)`, `eq(priceSnapshots.investmentId, X)`,
// etc. inside `.where(...)`. Inspecting drizzle's internal SQL AST via
// `queryChunks` couples the test to internal shape (the value lives at index
// 2 wrapped in a `Param`), so we mock `eq` itself with a predictable token
// shape. Every other drizzle export (asc/desc/and/gte/sql/etc.) stays
// untouched so the existing tests keep working.
mock.module("drizzle-orm", () => ({
  ...drizzleOrm,
  eq: (col: unknown, val: unknown) => ({ __isMockedEq: true as const, col, val }),
}));

// Type alias for the mocked eq() token. Using a private brand keeps the
// narrowing isolated to these test files.
type MockedEqToken = { __isMockedEq: true; col: unknown; val: unknown };

function asMockedEq(condition: unknown): MockedEqToken | null {
  if (
    condition &&
    typeof condition === "object" &&
    (condition as { __isMockedEq?: unknown }).__isMockedEq === true
  ) {
    return condition as MockedEqToken;
  }
  return null;
}

// ---------- Session mock ------------------------------------------------------------
// The new POST/DELETE routes use `requireSession` from
// `../../lib/session`. Mirror the same mock harness as crm.test.ts so the
// 401 ladder behaves identically and we don't have a parallel
// implementation that can drift.

const sessionStore = new Map<string, SessionData>();

mock.module("../../lib/session", () => ({
  createSession: (id: string, data: SessionData) => {
    sessionStore.set(id, data);
  },
  getSession: (id: string) => sessionStore.get(id),
  deleteSession: (id: string) => {
    sessionStore.delete(id);
  },
  // Strip the gmailClient `c.set(...)` call that production `requireSession`
  // performs — /portfolio never reads it, and mocking googleapis here
  // would be more harness than we need. The 401 ladder is otherwise
  // identical to production (see server/lib/session.ts).
  requireSession: async (c: Context, next: Next) => {
    const sid = getCookie(c, "sessionId") ?? getCookie(c, "session_id");
    if (!sid) return c.json({ error: "Not authenticated" }, 401);
    const session = sessionStore.get(sid);
    if (!session) return c.json({ error: "Not authenticated" }, 401);
    if (Date.now() > session.expiresAt) {
      sessionStore.delete(sid);
      return c.json({ error: "Not authenticated" }, 401);
    }
    await next();
  },
}));

// ---------- DB mock ----------------------------------------------------------------

const investmentsAll = mock(() => [] as Array<typeof investments.$inferSelect>);
const snapshotsAll = mock(
  () => [] as Array<typeof priceSnapshots.$inferSelect>,
);
const newsAll = mock(() => [] as Array<typeof newsItems.$inferSelect>);

// Discriminated insert/delete mocks so individual tests can verify that
// the production handler executed the expected operation in the expected
// order with the expected values.
const insertReturn = mock(
  (
    table: unknown,
    values: Record<string, unknown>,
  ): Array<Record<string, unknown>> => {
    if (table !== investments) {
      throw new Error(`Unexpected insert target in test: ${String(table)}`);
    }
    // Production autoincrements via the schema's `id` PK; the mock just
    // emits a fresh id each call so tests can assert on it if needed.
    const id = 900 + insertReturn.mock.calls.length;
    return [{ id, ...values }];
  },
);

const deleteOps: Array<{ table: unknown; condition: unknown }> = [];
const deleteRun = mock((table: unknown, condition: unknown) => {
  deleteOps.push({ table, condition });
});

const deleteInvestmentReturn = mock(
  (table: unknown, condition: unknown): Array<unknown> => {
    if (table !== investments) {
      throw new Error(`Unexpected delete target in test: ${String(table)}`);
    }
    const eq = asMockedEq(condition);
    if (!eq || eq.col !== investments.id || typeof eq.val !== "number") {
      throw new Error(
        `Unexpected delete condition on investments in test: ${String(condition)}`,
      );
    }
    return investmentsAll().filter((r) => r.id === eq.val);
  },
);

function makeChain(table: unknown) {
  if (table === investments) {
    return {
      orderBy: () => {
        return {
          all: () =>
            [...investmentsAll()].sort((a, b) =>
              a.ticker.localeCompare(b.ticker),
            ),
        };
      },
      // POST dedup pre-check uses `eq(ticker, X)`; DELETE lookup uses
      // `eq(id, X)`. Dispatch on the mocked eq token shape rather than
      // Drizzle's internal SQL AST.
      where: (condition: unknown) => {
        return {
          get: () => {
            const eq = asMockedEq(condition);
            if (!eq) return null;
            const rows = investmentsAll();
            // Split the && narrowing into nested ifs so TS carries the
            // `eq.val` narrow into the body without needing a cast.
            if (eq.col === investments.ticker) {
              if (typeof eq.val === "string") {
                const target = eq.val;
                return (
                  rows.find(
                    (r) => r.ticker.toUpperCase() === target.toUpperCase(),
                  ) ?? null
                );
              }
              return null;
            }
            if (eq.col === investments.id && typeof eq.val === "number") {
              return rows.find((r) => r.id === eq.val) ?? null;
            }
            return null;
          },
        };
      },
    };
  }
  if (table === priceSnapshots) {
    return {
      // The /news GET path passes `gte(...)` and `eq(investments.ticker, …)`
      // through this where. Existing tests don't inspect the arg; the new
      // POST/DELETE routes never read `priceSnapshots` via `select`.
      where: () => ({
        orderBy: () => ({
          limit: () => ({ all: snapshotsAll }),
        }),
      }),
    };
  }
  if (table === newsItems) {
    const limitNode = { all: newsAll };
    return {
      all: newsAll,
      leftJoin: () => ({
        where: () => ({ orderBy: () => ({ limit: () => limitNode }) }),
      }),
    };
  }
  throw new Error(`Unexpected table in test mock: ${String(table)}`);
}

const dbMockFactory = () => ({
  db: {
    select: mock(() => ({
      from: mock((table: unknown) => makeChain(table)),
    })),
    all: mock(async (queryPromise: Promise<unknown>) => {
      await queryPromise;
      return snapshotsAll();
    }),
    insert: mock((table: unknown) => ({
      values: (record: Record<string, unknown>) => ({
        returning: () => ({
          all: () => insertReturn(table, record),
        }),
      }),
    })),
    delete: mock((table: unknown) => {
      return {
        where: (condition: unknown) => {
          // Record the cascade at `where` time so we observe BOTH the
          // `.run()` path (priceSnapshots, newsItems) AND the
          // `.returning().all()` path (investments itself). If we
          // tracked only inside `.run()`, the final investments
          // delete would silently fall out of `deleteOps`.
          deleteOps.push({ table, condition });
          return {
            run: () => undefined,
            returning: () => ({
              all: () => deleteInvestmentReturn(table, condition),
            }),
          };
        },
      };
    }),
  },
});

mock.module("../../db/client", dbMockFactory);

// ---------- Setup / teardown --------------------------------------------------------

beforeEach(() => {
  investmentsAll.mockReset();
  investmentsAll.mockImplementation(() => []);
  snapshotsAll.mockReset();
  snapshotsAll.mockImplementation(() => []);
  newsAll.mockReset();
  newsAll.mockImplementation(() => []);
  // Use `mockClear` (not `mockReset`) on these mocks so the freshly
  // installed implementations survive across tests. Reset would strip
  // the implementation \u2014 our inserts and deletes start returning
  // `undefined`, which silently breaks assertions downstream.
  insertReturn.mockClear();
  deleteRun.mockClear();
  deleteInvestmentReturn.mockClear();
  deleteOps.length = 0;
  sessionStore.clear();
});

afterAll(() => {
  mock.restore();
});

// ---------- Helpers -----------------------------------------------------------------

type InvestmentRow = typeof investments.$inferSelect;
type SnapshotRow = typeof priceSnapshots.$inferSelect;

type InvestmentsBody = {
  investments: Array<{
    id: number;
    ticker: string;
    companyName: string;
    sector: string | null;
    shares: number;
    percentOfAccount: number | null;
    latestSnapshot: {
      price: number;
      change: number | null;
      percentChange: number | null;
      high: number | null;
      low: number | null;
      open: number | null;
      prevClose: number | null;
      timestamp: string;
    } | null;
    previousSnapshot: InvestmentsBody["investments"][number]["latestSnapshot"];
    delta: {
      price: number | null;
      percentChange: number | null;
    };
  }>;
};

async function jsonBody(res: Response): Promise<InvestmentsBody> {
  return (await res.json()) as InvestmentsBody;
}

function makeInvestment(overrides: Partial<InvestmentRow> = {}): InvestmentRow {
  return {
    id: 1,
    ticker: "AAPL",
    companyName: "Apple Inc.",
    sector: "Tech",
    shares: 10,
    percentOfAccount: 0.4,
    ...overrides,
  };
}

function makeSnapshot(overrides: Partial<SnapshotRow>): SnapshotRow {
  return {
    id: 0,
    investmentId: 1,
    price: 0,
    change: null,
    percentChange: null,
    high: null,
    low: null,
    open: null,
    prevClose: null,
    timestamp: new Date("2026-07-01T00:00:00Z"),
    ...overrides,
  };
}

// Returns a sessionId cookie value for an authenticated request to the
// new POST/DELETE routes. Mirrors the helper shape used in crm.test.ts so
// the two suites share the same auth-cookie conventions.
function makeSessionCookie(): string {
  const id = `portfolio-test-${crypto.randomUUID()}`;
  createSession(id, {
    tokens: { access_token: "fake" },
    expiresAt: Date.now() + 60 * 60 * 1000, // 1h validity
  });
  return `sessionId=${id}`;
}

// ---------- Suite ------------------------------------------------------------------

describe("GET /portfolio/investments", () => {
  it("returns 200 with an empty array when no investments are held", async () => {
    const res = await portfolio.request("/investments");
    expect(res.status).toBe(200);
    expect(await jsonBody(res)).toEqual({ investments: [] });
  });

  it("returns investments ordered by ticker ascending", async () => {
    investmentsAll.mockImplementation(() => [
      makeInvestment({ id: 2, ticker: "MSFT", companyName: "Microsoft" }),
      makeInvestment({ id: 1, ticker: "AAPL", companyName: "Apple Inc." }),
      makeInvestment({ id: 3, ticker: "GOOG", companyName: "Alphabet" }),
    ]);

    const body = await jsonBody(await portfolio.request("/investments"));
    expect(body.investments.map((r) => r.ticker)).toEqual([
      "AAPL",
      "GOOG",
      "MSFT",
    ]);
  });

  it("returns null snapshots and null delta when an investment has no snapshots", async () => {
    investmentsAll.mockImplementation(() => [makeInvestment()]);
    snapshotsAll.mockImplementation(() => []);

    const body = await jsonBody(await portfolio.request("/investments"));
    expect(body.investments[0]?.latestSnapshot).toBeNull();
    expect(body.investments[0]?.previousSnapshot).toBeNull();
    expect(body.investments[0]?.delta).toEqual({
      price: null,
      percentChange: null,
    });
  });

  it("treats single-snapshot investments the same way (delta fields all null)", async () => {
    investmentsAll.mockImplementation(() => [makeInvestment()]);
    snapshotsAll.mockImplementation(() => [
      makeSnapshot({
        id: 100,
        price: 110,
        timestamp: new Date("2026-07-02T00:00:00Z"),
      }),
    ]);

    const body = await jsonBody(await portfolio.request("/investments"));
    expect(body.investments[0]?.latestSnapshot?.price).toBe(110);
    expect(body.investments[0]?.previousSnapshot).toBeNull();
    expect(body.investments[0]?.delta).toEqual({
      price: null,
      percentChange: null,
    });
  });

  it("computes delta correctly for two snapshots on one investment", async () => {
    investmentsAll.mockImplementation(() => [makeInvestment()]);
    // Mock mirrors Query 2's (investment_id ASC, timestamp DESC) order:
    // index 0 is "latest", index 1 is "previous".
    snapshotsAll.mockImplementation(() => [
      makeSnapshot({
        id: 100,
        price: 110,
        timestamp: new Date("2026-07-02T00:00:00Z"),
      }),
      makeSnapshot({
        id: 99,
        price: 105,
        timestamp: new Date("2026-07-01T00:00:00Z"),
      }),
    ]);

    const body = await jsonBody(await portfolio.request("/investments"));
    expect(body.investments[0]?.latestSnapshot?.price).toBe(110);
    expect(body.investments[0]?.previousSnapshot?.price).toBe(105);
    expect(body.investments[0]?.delta.price).toBe(5);
    // (110 - 105) / 105 * 100 ≈ 4.7619 → 4.76 (round-to-2)
    expect(body.investments[0]?.delta.percentChange).toBe(4.76);
  });

  it("rounds percentChange to two decimal places (no float-tail digits)", async () => {
    investmentsAll.mockImplementation(() => [makeInvestment()]);
    snapshotsAll.mockImplementation(() => [
      makeSnapshot({
        id: 100,
        price: 33.33,
        timestamp: new Date("2026-07-02"),
      }),
      makeSnapshot({
        id: 99,
        price: 33.32,
        timestamp: new Date("2026-07-01"),
      }),
    ]);

    const body = await jsonBody(await portfolio.request("/investments"));
    // (33.33 − 33.32) / 33.32 × 100 ≈ 0.03003 → 0.03
    expect(body.investments[0]?.delta.percentChange).toBe(0.03);
  });

  it("uses only the first two snapshots per investment regardless of input order", async () => {
    investmentsAll.mockImplementation(() => [makeInvestment()]);
    // Three snapshots returned in deliberately-wrong order to verify the
    // assembly trusts "first two seen per key", not chronological order:
    // - id 999 first  →  kept as `latest`
    // - id 100 second →  kept as `previous`
    // - id 099 third  →  ignored
    snapshotsAll.mockImplementation(() => [
      makeSnapshot({
        id: 999,
        price: 999,
        timestamp: new Date("2026-07-03T00:00:00Z"),
      }),
      makeSnapshot({
        id: 100,
        price: 110,
        timestamp: new Date("2026-07-02T00:00:00Z"),
      }),
      makeSnapshot({
        id: 99,
        price: 100,
        timestamp: new Date("2026-07-01T00:00:00Z"),
      }),
    ]);

    const body = await jsonBody(await portfolio.request("/investments"));
    expect(body.investments[0]?.latestSnapshot?.price).toBe(999);
    expect(body.investments[0]?.previousSnapshot?.price).toBe(110);
    // Delta is computed against the kept pair (999 vs 110), not 110 vs 100.
    expect(body.investments[0]?.delta.price).toBe(889);
  });

  it("nulls delta fields when previous.price is zero (avoids NaN/Infinity)", async () => {
    investmentsAll.mockImplementation(() => [makeInvestment()]);
    snapshotsAll.mockImplementation(() => [
      makeSnapshot({
        id: 100,
        price: 110,
        timestamp: new Date("2026-07-02"),
      }),
      makeSnapshot({
        id: 99,
        price: 0,
        timestamp: new Date("2026-07-01"),
      }),
    ]);

    const body = await jsonBody(await portfolio.request("/investments"));
    expect(body.investments[0]?.delta).toEqual({
      price: null,
      percentChange: null,
    });
  });

  it("ignores snapshots whose investmentId is not in the held set", async () => {
    const aapl = makeInvestment({ id: 1, ticker: "AAPL" });
    investmentsAll.mockImplementation(() => [aapl]);
    // An unrelated investment_id=999 row in the mocked snapshot data
    // must not appear in the response even though the assembly map
    // would otherwise key it — verifies the inArray filter is doing
    // work, not just the map's key set.
    snapshotsAll.mockImplementation(() => [
      makeSnapshot({
        id: 100,
        investmentId: 1,
        price: 110,
        timestamp: new Date("2026-07-02T00:00:00Z"),
      }),
      makeSnapshot({
        id: 200,
        investmentId: 999,
        price: 50,
        timestamp: new Date("2026-07-02T00:00:00Z"),
      }),
    ]);

    const body = await jsonBody(await portfolio.request("/investments"));
    expect(body.investments).toHaveLength(1);
    expect(body.investments[0]?.latestSnapshot?.price).toBe(110);
    expect(body.investments[0]?.previousSnapshot).toBeNull();
  });

  it("returns a 500 envelope ({ message }) when the DB throws", async () => {
    investmentsAll.mockImplementation(() => {
      throw new Error("simulated DB failure");
    });

    const res = await portfolio.request("/investments");
    expect(res.status).toBe(500);
    const body = (await res.json()) as { message: string };
    expect(body).toEqual({ message: "Error fetching investments" });
  });

  it("returns timestamps as ISO strings (not Date instances)", async () => {
    investmentsAll.mockImplementation(() => [makeInvestment()]);
    snapshotsAll.mockImplementation(() => [
      makeSnapshot({
        id: 100,
        price: 110,
        timestamp: new Date("2026-07-02T12:34:56.000Z"),
      }),
    ]);

    const body = await jsonBody(await portfolio.request("/investments"));
    expect(body.investments[0]?.latestSnapshot?.timestamp).toBe(
      "2026-07-02T12:34:56.000Z",
    );
  });

  it("ensures each investment gets exactly its 2 most recent snapshots even if many snapshots exist", async () => {
    const inv1 = makeInvestment({ id: 1, ticker: "AAPL" });
    const inv2 = makeInvestment({ id: 2, ticker: "MSFT" });
    investmentsAll.mockImplementation(() => [inv1, inv2]);

    snapshotsAll.mockImplementation(() => [
      // AAPL: 3 snapshots, should get 2
      makeSnapshot({
        id: 1,
        investmentId: 1,
        price: 10,
        timestamp: new Date("2026-07-03"),
      }), // Latest
      makeSnapshot({
        id: 2,
        investmentId: 1,
        price: 9,
        timestamp: new Date("2026-07-02"),
      }), // Previous
      makeSnapshot({
        id: 3,
        investmentId: 1,
        price: 8,
        timestamp: new Date("2026-07-01"),
      }), // Should be ignored
      // MSFT: 3 snapshots, should get 2
      makeSnapshot({
        id: 4,
        investmentId: 2,
        price: 20,
        timestamp: new Date("2026-07-03"),
      }), // Latest
      makeSnapshot({
        id: 5,
        investmentId: 2,
        price: 19,
        timestamp: new Date("2026-07-02"),
      }), // Previous
      makeSnapshot({
        id: 6,
        investmentId: 2,
        price: 18,
        timestamp: new Date("2026-07-01"),
      }), // Should be ignored
    ]);

    const body = await jsonBody(await portfolio.request("/investments"));
    expect(body.investments).toHaveLength(2);

    const aapl = body.investments.find((i) => i.ticker === "AAPL");
    expect(aapl?.latestSnapshot?.price).toBe(10);
    expect(aapl?.previousSnapshot?.price).toBe(9);

    const msft = body.investments.find((i) => i.ticker === "MSFT");
    expect(msft?.latestSnapshot?.price).toBe(20);
    expect(msft?.previousSnapshot?.price).toBe(19);
  });
});

describe("GET /portfolio/sync-status", () => {
  // Each test self-seeds state: syncState module-level locals are shared
  // across the test process, so we avoid asserting on initial absence.

  it("reflects an in-flight run (inFlight: true)", async () => {
    recordSyncStart();
    const res = await portfolio.request("/sync-status");
    const body = (await res.json()) as { inFlight: boolean };
    expect(body.inFlight).toBe(true);
    recordSyncFinish(); // tidy for the next test
  });

  it("echoes the last successful run after recordSyncRun + recordSyncFinish", async () => {
    const outcome = {
      at: new Date("2026-07-02T00:00:00.000Z"),
      ok: true,
      note: "5 ticker(s) ok",
    };
    recordSyncRun(outcome);
    recordSyncFinish();
    const res = await portfolio.request("/sync-status");
    const body = (await res.json()) as {
      lastRun: { at: string; ok: boolean; note: string } | null;
      inFlight: boolean;
    };
    expect(body.inFlight).toBe(false);
    expect(body.lastRun).toEqual({
      at: "2026-07-02T00:00:00.000Z",
      ok: true,
      note: "5 ticker(s) ok",
    });
  });

  it("echoes a failed run (lastRun.ok === false)", async () => {
    const outcome = {
      at: new Date("2026-07-02T00:00:00.000Z"),
      ok: false,
      note: "simulated sync explosion",
    };
    recordSyncRun(outcome);
    recordSyncFinish();
    const res = await portfolio.request("/sync-status");
    const body = (await res.json()) as {
      lastRun: { at: string; ok: boolean; note: string } | null;
      inFlight: boolean;
    };
    expect(body.inFlight).toBe(false);
    expect(body.lastRun?.ok).toBe(false);
    expect(body.lastRun?.note).toBe("simulated sync explosion");
  });
});

describe("GET /portfolio/news", () => {
  it("returns the documented JSON shape with default days=7 (no ticker)", async () => {
    const res = await portfolio.request("/news");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      ticker: string | null;
      days: number;
      count: number;
      news: unknown[];
    };
    expect(body.ticker).toBe(null);
    expect(body.days).toBe(7);
    expect(body.count).toBe(0);
    expect(body.news).toEqual([]);
  });

  it("uppercases and echoes the ticker filter in the response", async () => {
    const res = await portfolio.request("/news?ticker=aapl");
    const body = (await res.json()) as { ticker: string; days: number };
    expect(body.ticker).toBe("AAPL");
    expect(body.days).toBe(7);
  });

  it("returns empty news for an unknown ticker (status 200, not 404)", async () => {
    const res = await portfolio.request("/news?ticker=ZZZZZZ");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      ticker: string;
      count: number;
      news: unknown[];
    };
    expect(body.news).toEqual([]);
    expect(body.count).toBe(0);
  });

  it("renders mock news rows with ISO-formatted timestamps", async () => {
    // Runtime shape is a joined row ({ news_items, investments }), not a
    // flat `news_items` row. bun's `mock()` is typed against the flat row;
    // double-cast bypasses the structural mismatch without changing
    // runtime behaviour.
    newsAll.mockImplementation(
      () =>
        [
          {
            news_items: {
              id: 7,
              investmentId: 1,
              finnhubId: 9999,
              headline: "Apple announces new product",
              url: "https://example.com/aapl",
              source: "TestSource",
              summary: "Test summary",
              timestamp: new Date("2026-07-02T12:00:00.000Z"),
            },
            investments: { ticker: "AAPL" },
          },
        ] as unknown as Array<typeof newsItems.$inferSelect>,
    );

    const res = await portfolio.request("/news?ticker=AAPL");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      count: number;
      news: Array<{
        id: number;
        ticker: string | null;
        headline: string;
        timestamp: string;
      }>;
    };
    expect(body.count).toBe(1);
    expect(body.news[0]).toMatchObject({
      id: 7,
      ticker: "AAPL",
      headline: "Apple announces new product",
    });
    expect(body.news[0]?.timestamp).toBe("2026-07-02T12:00:00.000Z");
  });

  it("rejects non-numeric days with 400 via zValidator", async () => {
    const res = await portfolio.request("/news?days=foo");
    expect(res.status).toBe(400);
  });

  it("rejects days=0 with 400 (must be >= 1)", async () => {
    const res = await portfolio.request("/news?days=0");
    expect(res.status).toBe(400);
  });

  it("rejects days=31 with 400 (must be <= 30)", async () => {
    const res = await portfolio.request("/news?days=31");
    expect(res.status).toBe(400);
  });

  it("returns a 500 envelope ({ message }) when the /news query throws", async () => {
    newsAll.mockImplementation(() => {
      throw new Error("simulated DB failure");
    });
    const res = await portfolio.request("/news");
    expect(res.status).toBe(500);
    const body = (await res.json()) as { message: string };
    expect(body).toEqual({ message: "Error fetching news" });
  });
});

// ---------- POST /portfolio/investments -------------------------------------------
//
// Auth, validation, dedup, and success envelopes. Inserted-row shape is
// compared against the production handler's `.returning()` contract:
// `[0]` is the row object as Drizzle would emit it (camelCase preserved).

type InsertedInvestment = {
  id: number;
  ticker: string;
  companyName: string;
  sector: string;
  shares: number;
};

describe("POST /portfolio/investments", () => {
  const path = "/investments";

  it("returns 401 when no session cookie is present", async () => {
    const res = await portfolio.request(path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        ticker: "AAPL",
        companyName: "Apple Inc.",
        sector: "Technology",
        shares: 10,
      }),
    });
    expect(res.status).toBe(401);
  });

  it("returns 401 when the cookie value does not match any active session", async () => {
    const res = await portfolio.request(path, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Cookie: "sessionId=does-not-exist",
      },
      body: JSON.stringify({
        ticker: "AAPL",
        companyName: "Apple Inc.",
        sector: "Technology",
        shares: 10,
      }),
    });
    expect(res.status).toBe(401);
  });

  it("returns 400 when shares is missing", async () => {
    const res = await portfolio.request(path, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Cookie: makeSessionCookie(),
      },
      body: JSON.stringify({
        ticker: "AAPL",
        companyName: "Apple Inc.",
        sector: "Technology",
      }),
    });
    expect(res.status).toBe(400);
  });

  it("returns 400 when shares is negative", async () => {
    const res = await portfolio.request(path, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Cookie: makeSessionCookie(),
      },
      body: JSON.stringify({
        ticker: "AAPL",
        companyName: "Apple Inc.",
        sector: "Technology",
        shares: -1,
      }),
    });
    expect(res.status).toBe(400);
  });

  it("returns 400 when ticker exceeds 10 characters", async () => {
    const res = await portfolio.request(path, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Cookie: makeSessionCookie(),
      },
      body: JSON.stringify({
        ticker: "TOOLONGTICKER",
        companyName: "Long Co.",
        sector: "Tech",
        shares: 10,
      }),
    });
    expect(res.status).toBe(400);
  });

  it("returns 201 and the inserted row on a valid request, with ticker uppercased", async () => {
    const res = await portfolio.request(path, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Cookie: makeSessionCookie(),
      },
      // Lowercase `aapl` here proves the Zod `.transform(toUpperCase)`
      // and the case-insensitive dedup path work together.
      body: JSON.stringify({
        ticker: "aapl",
        companyName: "Apple Inc.",
        sector: "Technology",
        shares: 25,
      }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as InsertedInvestment;
    expect(body.ticker).toBe("AAPL");
    expect(body.companyName).toBe("Apple Inc.");
    expect(body.sector).toBe("Technology");
    expect(body.shares).toBe(25);
    expect(typeof body.id).toBe("number");
  });

  it("returns 409 when a row with the same ticker already exists (case-insensitive)", async () => {
    investmentsAll.mockImplementation(() => [
      makeInvestment({ id: 1, ticker: "AAPL", companyName: "Apple Inc." }),
    ]);
    const res = await portfolio.request(path, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Cookie: makeSessionCookie(),
      },
      body: JSON.stringify({
        ticker: "aapl", // duplicate of an existing AAPL row
        companyName: "Apple Duplicate",
        sector: "Tech",
        shares: 5,
      }),
    });
    expect(res.status).toBe(409);
    const body = (await res.json()) as { message: string };
    expect(body.message).toMatch(/AAPL/i);
  });
});

// ---------- DELETE /portfolio/investments/:id -------------------------------------

describe("DELETE /portfolio/investments/:id", () => {
  it("returns 401 when no session cookie is present", async () => {
    const res = await portfolio.request("/investments/1", { method: "DELETE" });
    expect(res.status).toBe(401);
  });

  it("returns 400 when :id is not a positive integer", async () => {
    const res = await portfolio.request("/investments/abc", {
      method: "DELETE",
      headers: { Cookie: makeSessionCookie() },
    });
    expect(res.status).toBe(400);
  });

  it("returns 400 when :id is zero or negative", async () => {
    const zero = await portfolio.request("/investments/0", {
      method: "DELETE",
      headers: { Cookie: makeSessionCookie() },
    });
    expect(zero.status).toBe(400);
    const neg = await portfolio.request("/investments/-3", {
      method: "DELETE",
      headers: { Cookie: makeSessionCookie() },
    });
    expect(neg.status).toBe(400);
  });

  it("returns 404 when the investment does not exist", async () => {
    investmentsAll.mockImplementation(() => []);
    const res = await portfolio.request("/investments/9999", {
      method: "DELETE",
      headers: { Cookie: makeSessionCookie() },
    });
    expect(res.status).toBe(404);
  });

  it("returns 204 and cascades dependents on success", async () => {
    const target = makeInvestment({ id: 42, ticker: "MSFT" });
    investmentsAll.mockImplementation(() => [target]);

    const res = await portfolio.request("/investments/42", {
      method: "DELETE",
      headers: { Cookie: makeSessionCookie() },
    });
    expect(res.status).toBe(204);
    // 204 No Content — verify the body is empty.
    expect(await res.text()).toBe("");

    // Cascade order is intentional: price_snapshots → news_items →
    // investments. We assert the operations happened (and on the right
    // foreign-key column) but not the exact order, because Drizzle's
    // mock fn call list is sufficient evidence for the production
    // semantics.
    const tableSequence = deleteOps.map((op) =>
      op.table === priceSnapshots
        ? "price_snapshots"
        : op.table === newsItems
          ? "news_items"
          : op.table === investments
            ? "investments"
            : "unknown",
    );
    expect(tableSequence).toContain("price_snapshots");
    expect(tableSequence).toContain("news_items");
    expect(tableSequence).toContain("investments");
    // Filter column must be the *FK column*, not the row id, on the
    // dependent tables.
    const dependentByInvestmentId = (table: unknown, fkColumn: unknown) =>
      deleteOps.some((op) => {
        if (op.table !== table) return false;
        const eq = asMockedEq(op.condition);
        if (!eq) return false;
        return eq.col === fkColumn && eq.val === 42;
      });
    expect(
      dependentByInvestmentId(priceSnapshots, priceSnapshots.investmentId),
    ).toBe(true);
    expect(dependentByInvestmentId(newsItems, newsItems.investmentId)).toBe(
      true,
    );
    // The final investments delete must target `investments.id`, not
    // any other column.
    const investmentDelete = deleteOps.find((op) => op.table === investments);
    const investmentEq = investmentDelete
      ? asMockedEq(investmentDelete.condition)
      : null;
    expect(investmentEq?.col).toBe(investments.id);
    expect(investmentEq?.val).toBe(42);
  });
});
