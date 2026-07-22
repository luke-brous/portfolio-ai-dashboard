import { describe, it, expect, mock, beforeEach, afterAll } from "bun:test";
import portfolio from "../portfolio";
import { investments, priceSnapshots, newsItems } from "../../db/schema";
import { recordSyncFinish, recordSyncRun, recordSyncStart } from "../../lib/syncState";

// ---------- Module mocks ------------------------------------------------------------
//
// `server/routes/portfolio.ts` imports `{ db } from "../db/client"` — the
// DAG-preserving path documented in server/db/client.ts. We mock that exact
// module here (resolved from this test file as `../../db/client`), so the
// production route never touches a real SQLite connection.

const investmentsAll = mock(
    () => [] as Array<typeof investments.$inferSelect>,
);
const snapshotsAll = mock(
    () => [] as Array<typeof priceSnapshots.$inferSelect>,
);
const newsAll = mock(() => [] as Array<typeof newsItems.$inferSelect>);

function makeChain(table: unknown) {
    if (table === investments) {
        // Mirror the production `orderBy(asc(investments.ticker))` behaviour:
        // sort the mocked rows by ticker descending—er, ascending. Whatever
        // direction the test opts into, sort accordingly.
        return {
            orderBy: () => {
                const rows = investmentsAll();
                // Drizzle's `asc` returns a column descriptor; the real query
                // is sorted ASC by the underlying column. Tests only assert
                // on the AAPL→GOOG→MSFT direction (ASC), so sort ascending.
                return {
                    all: () =>
                        [...rows].sort((a, b) =>
                            a.ticker.localeCompare(b.ticker),
                        ),
                };
            },
        };
    }
    if (table === priceSnapshots) {
        return {
            where: () => ({
                orderBy: () => ({
                    limit: () => ({ all: snapshotsAll }),
                }),
            }),
        };
    }
    if (table === newsItems) {
        // /portfolio/news: db.select().from(newsItems)
        //   .leftJoin(investments, ...).where(...).orderBy(...).limit(...).all().
        const limitNode = { all: newsAll };
        return {
            // Reserved for any future direct-all read.
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
            absoluteChange: number | null;
        };
    }>;
};

async function jsonBody(res: Response): Promise<InvestmentsBody> {
    return (await res.json()) as InvestmentsBody;
}

function makeInvestment(
    overrides: Partial<InvestmentRow> = {},
): InvestmentRow {
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
            absoluteChange: null,
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
            absoluteChange: null,
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
        expect(body.investments[0]?.delta.absoluteChange).toBe(5);
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
            absoluteChange: null,
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
        const body = (await res.json()) as { ticker: string; count: number; news: unknown[] };
        expect(body.news).toEqual([]);
        expect(body.count).toBe(0);
    });

    it("renders mock news rows with ISO-formatted timestamps", async () => {
        // Runtime shape is a joined row ({ news_items, investments }), not a
        // flat `news_items` row. bun's `mock()` is typed against the flat row;
        // double-cast bypasses the structural mismatch without changing
        // runtime behaviour.
        newsAll.mockImplementation(() => [
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
        ] as unknown as Array<typeof newsItems.$inferSelect>);

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
