import { describe, it, expect, mock, beforeEach, afterAll } from "bun:test";
import { getCookie } from "hono/cookie";
import type { Context, Next } from "hono";
import crypto from "crypto";

import crm from "../crm";
import { nonprofits } from "../../db/schema";
import { createSession } from "../../lib/session";
import type { SessionData } from "../../types/session";

// ---------- Module mocks ----------------------------------------------------------
//
//
//

const sessionStore = new Map<string, SessionData>();

mock.module("../../lib/session", () => ({
  createSession: (id: string, data: SessionData) => {
    sessionStore.set(id, data);
  },
  getSession: (id: string) => sessionStore.get(id),
  deleteSession: (id: string) => {
    sessionStore.delete(id);
  },
  // Mirror the production `requireSession` 401 ladder:
  //   1. no cookie                          -> 401 "Not authenticated"
  //   2. cookie present, no session in store -> 401 "Not authenticated"
  //   3. session present, past expiresAt     -> deleteSession + 401 "Session expired"
  //   4. otherwise                           -> next()
  // We deliberately omit the OAuth + googleapis plumbing because the
  // CRM read path doesn't touch `c.get("gmailClient")`.
  requireSession: async (c: Context, next: Next) => {
    const sessionId = getCookie(c, "sessionId") ?? getCookie(c, "session_id");
    if (!sessionId) {
      return c.json({ error: "Not authenticated" }, 401);
    }
    const session = sessionStore.get(sessionId);
    if (!session) {
      return c.json({ error: "Not authenticated" }, 401);
    }
    if (Date.now() > session.expiresAt) {
      sessionStore.delete(sessionId);
      return c.json({ error: "Not authenticated" }, 401);
    }
    await next();
  },
}));

const nonprofitsAll = mock(() => [] as Array<typeof nonprofits.$inferSelect>);

mock.module("../../db/client", () => ({
  db: {
    select: mock((opts?: unknown) => {
      // Two call shapes hit the route:
      //   1. db.select({ c: count() }).from(<table>).get()  -> total
      //      (opts is an object with `c` key)
      //   2. db.select().from(<table>).orderBy(<col>)
      //            .limit(N).offset(M).all()                -> page
      //      (opts is undefined)
      if (opts && typeof opts === "object" && "c" in opts) {
        return {
          from: () => ({
            get: () => ({ c: nonprofitsAll().length }),
          }),
        };
      }
      return {
        from: (table: unknown) => {
          if (table !== nonprofits) {
            throw new Error(
              `Unexpected table in crm test mock: ${String(table)}`,
            );
          }
          return {
            // Verify the production route actually passes
            // `nonprofits.name` to `.orderBy(...)`. Without this guard,
            // the ASC test would still pass even if the route stopped
            // calling `.orderBy(...)` or called it with the wrong
            // column — the mock would silently sort by `name` anyway.
            orderBy: (column: unknown) => {
              if (column !== nonprofits.name) {
                throw new Error(
                  `orderBy called with wrong column: ${String(column)}`,
                );
              }
              return {
                limit: (n: number) => ({
                  offset: (o: number) => ({
                    all: () => {
                      const sorted = [...nonprofitsAll()].sort((a, b) =>
                        a.name.localeCompare(b.name),
                      );
                      return sorted.slice(o, o + n);
                    },
                  }),
                }),
              };
            },
          };
        },
      };
    }),
  },
}));

// ---------- Setup / teardown ------------------------------------------------------

beforeEach(() => {
  nonprofitsAll.mockReset();
  nonprofitsAll.mockImplementation(() => []);
  sessionStore.clear();
});

afterAll(() => {
  mock.restore();
});

// ---------- Helpers ---------------------------------------------------------------

type NonprofitRow = typeof nonprofits.$inferSelect;

function makeNonprofit(overrides: Partial<NonprofitRow> = {}): NonprofitRow {
  // `name` is NOT NULL on the production schema; everything else is
  // nullable, so the default fixture models the "all-null optional
  // fields" case.
  return {
    id: 1,
    name: "Default",
    contactEmail: null,
    grantCycleDates: null,
    grantAmount: null,
    grantStatus: null,
    ...overrides,
  };
}

function makeSession(opts: { expired?: boolean } = {}): string {
  const id = `test-session-${crypto.randomUUID()}`;
  createSession(id, {
    tokens: { access_token: "fake" },
    expiresAt: opts.expired ? Date.now() - 1_000 : Date.now() + 60 * 60 * 1_000, // 1h validity
  });
  return id;
}

function authCookie(opts: { expired?: boolean } = {}): string {
  return `sessionId=${makeSession(opts)}`;
}

async function jsonBody(res: Response): Promise<unknown> {
  return res.json();
}

// ---------- Suite -----------------------------------------------------------------

describe("GET /crm/nonprofits", () => {
  it("returns 401 when no session cookie is present", async () => {
    const res = await crm.request("/nonprofits");
    expect(res.status).toBe(401);
  });

  it("returns 401 when the cookie value doesn't match any active session", async () => {
    const res = await crm.request("/nonprofits", {
      headers: { Cookie: "sessionId=does-not-exist" },
    });
    expect(res.status).toBe(401);
  });

  it("returns 401 when the session is expired (per `expiresAt`)", async () => {
    const res = await crm.request("/nonprofits", {
      headers: { Cookie: authCookie({ expired: true }) },
    });
    expect(res.status).toBe(401);
  });

  it("accepts the legacy `session_id` cookie fallback when `sessionId` is absent", async () => {
    const id = makeSession();
    const res = await crm.request("/nonprofits", {
      headers: { Cookie: `session_id=${id}` },
    });
    expect(res.status).toBe(200);
  });

  it("returns the documented pagination envelope when the table is empty", async () => {
    const res = await crm.request("/nonprofits", {
      headers: { Cookie: authCookie() },
    });
    expect(res.status).toBe(200);
    expect(await jsonBody(res)).toEqual({
      count: 0,
      total: 0,
      limit: 50, // default
      offset: 0, // default
      nonprofits: [],
    });
  });

  it("returns three rows sorted by name ascending regardless of insertion order", async () => {
    // Insertion order is intentionally Z → A → M so the test fails if
    // `orderBy(nonprofits.name)` is bypassed.
    nonprofitsAll.mockImplementation(() => [
      makeNonprofit({ id: 2, name: "Z Foundation" }),
      makeNonprofit({ id: 1, name: "A Foundation" }),
      makeNonprofit({ id: 3, name: "M Foundation" }),
    ]);

    const body = (await jsonBody(
      await crm.request("/nonprofits", { headers: { Cookie: authCookie() } }),
    )) as { count: number; total: number; nonprofits: NonprofitRow[] };
    expect(body.count).toBe(3);
    expect(body.total).toBe(3);
    expect(body.nonprofits.map((r) => r.name)).toEqual([
      "A Foundation",
      "M Foundation",
      "Z Foundation",
    ]);
  });

  it("returns rows with all-null optional fields as `null` (not `undefined`)", async () => {
    nonprofitsAll.mockImplementation(() => [
      makeNonprofit({ id: 1, name: "Sparse Row" }),
    ]);

    const body = (await jsonBody(
      await crm.request("/nonprofits", { headers: { Cookie: authCookie() } }),
    )) as { nonprofits: NonprofitRow[] };
    const row = body.nonprofits[0];
    // Use explicit null assertions — leaving any of these as `undefined`
    // would break the CrmCard component's `== null` checks.
    expect(row?.contactEmail).toBeNull();
    expect(row?.grantCycleDates).toBeNull();
    expect(row?.grantAmount).toBeNull();
    expect(row?.grantStatus).toBeNull();
  });

  it("echoes populated optional fields through the response unchanged", async () => {
    nonprofitsAll.mockImplementation(() => [
      makeNonprofit({
        id: 1,
        name: "Filled Row",
        contactEmail: "info@example.org",
        grantCycleDates: "2026-01 → 2026-12",
        grantAmount: 50_000,
        grantStatus: "Active",
      }),
    ]);

    const body = (await jsonBody(
      await crm.request("/nonprofits", { headers: { Cookie: authCookie() } }),
    )) as { nonprofits: NonprofitRow[] };
    expect(body.nonprofits[0]?.contactEmail).toBe("info@example.org");
    expect(body.nonprofits[0]?.grantAmount).toBe(50_000);
    expect(body.nonprofits[0]?.grantStatus).toBe("Active");
  });

  it("returns a 500 envelope `{ message }` when the DB read throws", async () => {
    nonprofitsAll.mockImplementation(() => {
      throw new Error("simulated DB failure");
    });

    const res = await crm.request("/nonprofits", {
      headers: { Cookie: authCookie() },
    });
    expect(res.status).toBe(500);
    expect(await jsonBody(res)).toEqual({
      message: "Error fetching nonprofits",
    });
  });

  // ---- pagination ----

  it("honors `?limit=2&offset=0` and returns a 2-row page with `total: 3`", async () => {
    nonprofitsAll.mockImplementation(() => [
      makeNonprofit({ id: 1, name: "A Foundation" }),
      makeNonprofit({ id: 2, name: "B Foundation" }),
      makeNonprofit({ id: 3, name: "C Foundation" }),
    ]);

    const body = (await jsonBody(
      await crm.request("/nonprofits?limit=2&offset=0", {
        headers: { Cookie: authCookie() },
      }),
    )) as {
      count: number;
      total: number;
      limit: number;
      offset: number;
      nonprofits: NonprofitRow[];
    };
    expect(body.count).toBe(2);
    expect(body.total).toBe(3);
    expect(body.limit).toBe(2);
    expect(body.offset).toBe(0);
    expect(body.nonprofits.map((r) => r.name)).toEqual([
      "A Foundation",
      "B Foundation",
    ]);
  });

  it("honors `?offset=2` to skip to the third row", async () => {
    nonprofitsAll.mockImplementation(() => [
      makeNonprofit({ id: 1, name: "A Foundation" }),
      makeNonprofit({ id: 2, name: "B Foundation" }),
      makeNonprofit({ id: 3, name: "C Foundation" }),
    ]);

    const body = (await jsonBody(
      await crm.request("/nonprofits?limit=1&offset=2", {
        headers: { Cookie: authCookie() },
      }),
    )) as {
      count: number;
      limit: number;
      offset: number;
      nonprofits: NonprofitRow[];
    };
    expect(body.count).toBe(1);
    expect(body.limit).toBe(1);
    expect(body.offset).toBe(2);
    expect(body.nonprofits.map((r) => r.name)).toEqual(["C Foundation"]);
  });

  it("returns an empty page (count: 0) when offset is past the last row", async () => {
    nonprofitsAll.mockImplementation(() => [
      makeNonprofit({ id: 1, name: "A Foundation" }),
      makeNonprofit({ id: 2, name: "B Foundation" }),
    ]);

    const body = (await jsonBody(
      await crm.request("/nonprofits?offset=99", {
        headers: { Cookie: authCookie() },
      }),
    )) as { count: number; total: number; nonprofits: NonprofitRow[] };
    expect(body.count).toBe(0);
    expect(body.total).toBe(2);
    expect(body.nonprofits).toEqual([]);
  });

  it("rejects `?limit=-1` with 400 via zValidator", async () => {
    const res = await crm.request("/nonprofits?limit=-1", {
      headers: { Cookie: authCookie() },
    });
    expect(res.status).toBe(400);
  });

  it("rejects `?limit=9999` with 400 (max 100 enforced)", async () => {
    const res = await crm.request("/nonprofits?limit=9999", {
      headers: { Cookie: authCookie() },
    });
    expect(res.status).toBe(400);
  });

  it("rejects `?offset=-1` with 400 (must be >= 0)", async () => {
    const res = await crm.request("/nonprofits?offset=-1", {
      headers: { Cookie: authCookie() },
    });
    expect(res.status).toBe(400);
  });
});
