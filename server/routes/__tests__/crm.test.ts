import { describe, it, expect, mock, beforeEach, afterAll } from "bun:test";
import { getCookie } from "hono/cookie";
import type { Context, Next } from "hono";
import crypto from "crypto";
import * as drizzleOrm from "drizzle-orm";

import crm from "../crm";
import { nonprofits, reports } from "../../db/schema";
import { createSession } from "../../lib/session";
import type { SessionData } from "../../types/session";

// ---------- drizzle-orm mock --------------------------------------------------------
//
// Production calls `eq(nonprofits.id, X)` inside `.where(...)`. Mocking
// `eq` itself with a predictable token shape keeps our where-mock
// dispatch independent of Drizzle internals (the value lives at index 2
// of `queryChunks`, wrapped in a `Param`). Other drizzle exports
// (asc/desc/and/count/etc.) keep their real implementations.
mock.module("drizzle-orm", () => ({
  ...drizzleOrm,
  eq: (col: unknown, val: unknown) => ({
    __isMockedEq: true as const,
    col,
    val,
  }),
}));

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

// Verifiable insert/update audit so each test can assert on what the
// production handler actually wrote without re-reading rows out of a
// shared mocked table. `updateOps` is keyed by id and stores the
// cumulative patch (PATCH calls are observed destructured into the row).
const deleteOps: Array<{ table: "nonprofits" | "reports"; id: number }> = [];

const insertReturn = mock(
  (
    _table: unknown,
    values: Record<string, unknown>,
  ): Array<Record<string, unknown>> => {
    // Simulate autoincrement id so tests can assert on it.
    const id = 800 + insertReturn.mock.calls.length;
    return [{ id, ...values }];
  },
);

mock.module("../../db/client", () => ({
  db: {
    select: mock((opts?: unknown) => {
      // Three call shapes hit the route now:
      //   1. db.select({ c: count() }).from(<table>).get()  → total
      //      (opts is an object with `c` key)
      //   2. db.select().from(<table>).where(eq(<id>, X))
      //            .get()                                   → lookup by id (PATCH)
      //   3. db.select().from(<table>).orderBy(<col>)
      //            .limit(N).offset(M).all()                 → page (GET)
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
            // PATCH lookup: returns the row matching eq(id, X) or null.
            where: (condition: unknown) => {
              const eq = asMockedEq(condition);
              if (
                !eq ||
                eq.col !== nonprofits.id ||
                typeof eq.val !== "number"
              ) {
                throw new Error(
                  `Unexpected where condition in crm test mock: ${String(condition)}`,
                );
              }
              const id = eq.val;
              return {
                get: () => nonprofitsAll().find((r) => r.id === id) ?? null,
              };
            },
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
    insert: mock((table: unknown) => {
      if (table !== nonprofits) {
        throw new Error(
          `Unexpected insert target in crm test mock: ${String(table)}`,
        );
      }
      return {
        values: (record: Record<string, unknown>) => ({
          returning: () => ({
            all: () => insertReturn(table, record),
          }),
        }),
      };
    }),
    // DELETE /nonprofits/:id issues two deletes: the dependent `reports`
    // rows first, then the nonprofit itself. `deleteOps` records the
    // (table, id) pairs in call order so a test can assert the cascade
    // ordering rather than just the end state.
    delete: mock((table: unknown) => {
      if (table !== nonprofits && table !== reports) {
        throw new Error(
          `Unexpected delete target in crm test mock: ${String(table)}`,
        );
      }
      return {
        where: (condition: unknown) => {
          const eq = asMockedEq(condition);
          const expectedCol =
            table === nonprofits ? nonprofits.id : reports.nonprofitId;
          if (!eq || eq.col !== expectedCol || typeof eq.val !== "number") {
            throw new Error(
              `Delete where called with bad condition: ${String(condition)}`,
            );
          }
          const id = eq.val;
          deleteOps.push({
            table: table === nonprofits ? "nonprofits" : "reports",
            id,
          });
          return {
            // `reports` cascade uses .run(); the parent delete uses
            // .returning().all() so the route can detect a lost race.
            run: () => undefined,
            returning: () => ({
              all: () => {
                const existing = nonprofitsAll().find((r) => r.id === id);
                return existing ? [existing] : [];
              },
            }),
          };
        },
      };
    }),
    update: mock((table: unknown) => {
      if (table !== nonprofits) {
        throw new Error(
          `Unexpected update target in crm test mock: ${String(table)}`,
        );
      }
      return {
        set: (patch: Partial<Record<string, unknown>>) => ({
          where: (condition: unknown) => {
            const eq = asMockedEq(condition);
            if (!eq || eq.col !== nonprofits.id || typeof eq.val !== "number") {
              throw new Error(
                `Update where called with bad condition: ${String(condition)}`,
              );
            }
            const id = eq.val;
            return {
              returning: () => ({
                all: () => {
                  const existing = nonprofitsAll().find((r) => r.id === id);
                  if (!existing) return [];
                  // Apply the patch onto a clone so we don't mutate
                  // the fixture (the next test should see the pristine
                  // fixture).
                  return [{ ...existing, ...patch }];
                },
              }),
            };
          },
        }),
      };
    }),
  },
}));

// ---------- Setup / teardown ------------------------------------------------------

beforeEach(() => {
  nonprofitsAll.mockReset();
  nonprofitsAll.mockImplementation(() => []);
  sessionStore.clear();
  deleteOps.length = 0;
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

// ---------- POST /crm/nonprofits ---------------------------------------------------
//
// Auth + validation + success envelopes. The crm mount already runs
// `crm.use("*", requireSession)`, so every test in this section uses the
// `authCookie()` helper from the suite above.

type InsertedNonprofit = {
  id: number;
  name: string;
  contactEmail: string | null;
  grantCycleDates: string | null;
  grantAmount: number | null;
  grantStatus: string | null;
};

describe("POST /crm/nonprofits", () => {
  const path = "/nonprofits";

  it("returns 401 when no session cookie is present", async () => {
    const res = await crm.request(path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Acme Foundation" }),
    });
    expect(res.status).toBe(401);
  });

  it("returns 401 when the session is expired", async () => {
    const res = await crm.request(path, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Cookie: authCookie({ expired: true }),
      },
      body: JSON.stringify({ name: "Acme Foundation" }),
    });
    expect(res.status).toBe(401);
  });

  it("returns 400 when `name` is missing", async () => {
    const res = await crm.request(path, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Cookie: authCookie(),
      },
      body: JSON.stringify({ contactEmail: "info@example.org" }),
    });
    expect(res.status).toBe(400);
  });

  it("returns 400 when `contactEmail` is not a valid email", async () => {
    const res = await crm.request(path, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Cookie: authCookie(),
      },
      body: JSON.stringify({
        name: "Acme",
        contactEmail: "not-an-email",
      }),
    });
    expect(res.status).toBe(400);
  });

  it("returns 400 when `grantAmount` is negative", async () => {
    const res = await crm.request(path, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Cookie: authCookie(),
      },
      body: JSON.stringify({
        name: "Acme",
        grantAmount: -100,
      }),
    });
    expect(res.status).toBe(400);
  });

  it("returns 201 with the inserted row when only required fields are provided", async () => {
    const res = await crm.request(path, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Cookie: authCookie(),
      },
      body: JSON.stringify({ name: "Acme Foundation" }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as InsertedNonprofit;
    expect(body.name).toBe("Acme Foundation");
    // Optional fields default to null when not provided so the wire
    // shape matches what CrmCard already renders for unseeded rows.
    expect(body.contactEmail).toBeNull();
    expect(body.grantCycleDates).toBeNull();
    expect(body.grantAmount).toBeNull();
    expect(body.grantStatus).toBeNull();
    expect(typeof body.id).toBe("number");
  });

  it("returns 201 with all populated fields when every optional field is supplied", async () => {
    const res = await crm.request(path, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Cookie: authCookie(),
      },
      body: JSON.stringify({
        name: "Filled Foundation",
        contactEmail: "grants@example.org",
        grantCycleDates: "2026-01 → 2026-12",
        grantAmount: 50000,
        grantStatus: "Active",
      }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as InsertedNonprofit;
    expect(body.name).toBe("Filled Foundation");
    expect(body.contactEmail).toBe("grants@example.org");
    expect(body.grantCycleDates).toBe("2026-01 → 2026-12");
    expect(body.grantAmount).toBe(50000);
    expect(body.grantStatus).toBe("Active");
  });
});

// ---------- PATCH /crm/nonprofits/:id ----------------------------------------------
//
// Partial-update semantics are the core contract: only fields provided
// in the body are written. Empty bodies, invalid ids, and missing rows
// all surface as expected status codes.

describe("PATCH /crm/nonprofits/:id", () => {
  // Each test calls `authCookie()` inline rather than capturing a
  // describe-scope cookie: `beforeEach` clears the session store, so
  // any cookie captured before the first test would 401 by the time
  // the request fires.

  it("returns 401 when no session cookie is present", async () => {
    const res = await crm.request("/nonprofits/1", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Renamed" }),
    });
    expect(res.status).toBe(401);
  });

  it("returns 400 when :id is not a positive integer", async () => {
    const res = await crm.request("/nonprofits/abc", {
      method: "PATCH",
      headers: { "Content-Type": "application/json", Cookie: authCookie() },
      body: JSON.stringify({ name: "Renamed" }),
    });
    expect(res.status).toBe(400);
  });

  it("returns 400 when :id is 0 or negative", async () => {
    const zero = await crm.request("/nonprofits/0", {
      method: "PATCH",
      headers: { "Content-Type": "application/json", Cookie: authCookie() },
      body: JSON.stringify({ name: "Renamed" }),
    });
    expect(zero.status).toBe(400);
    const neg = await crm.request("/nonprofits/-5", {
      method: "PATCH",
      headers: { "Content-Type": "application/json", Cookie: authCookie() },
      body: JSON.stringify({ name: "Renamed" }),
    });
    expect(neg.status).toBe(400);
  });

  it("returns 400 when the body is empty (no fields to patch)", async () => {
    const res = await crm.request("/nonprofits/1", {
      method: "PATCH",
      headers: { "Content-Type": "application/json", Cookie: authCookie() },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
  });

  it("returns 404 when the nonprofit does not exist", async () => {
    nonprofitsAll.mockImplementation(() => []);
    const res = await crm.request("/nonprofits/9999", {
      method: "PATCH",
      headers: { "Content-Type": "application/json", Cookie: authCookie() },
      body: JSON.stringify({ name: "Renamed" }),
    });
    expect(res.status).toBe(404);
  });

  it("returns 200 and applies a single-field patch (other fields untouched)", async () => {
    const existing = makeNonprofit({
      id: 7,
      name: "Old Name",
      contactEmail: "old@example.org",
      grantCycleDates: "2025",
      grantAmount: 10_000,
      grantStatus: "Active",
    });
    nonprofitsAll.mockImplementation(() => [existing]);

    const res = await crm.request("/nonprofits/7", {
      method: "PATCH",
      headers: { "Content-Type": "application/json", Cookie: authCookie() },
      body: JSON.stringify({ name: "New Name" }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as InsertedNonprofit;
    expect(body.name).toBe("New Name");
    // Any field the client did NOT include must come back exactly as
    // it was on the existing row \u2014 partial-update semantics.
    expect(body.contactEmail).toBe("old@example.org");
    expect(body.grantCycleDates).toBe("2025");
    expect(body.grantAmount).toBe(10_000);
    expect(body.grantStatus).toBe("Active");
  });

  it("returns 200 and applies a multi-field patch", async () => {
    nonprofitsAll.mockImplementation(() => [
      makeNonprofit({
        id: 8,
        name: "Before",
        contactEmail: "before@example.org",
        grantAmount: 1000,
      }),
    ]);
    const res = await crm.request("/nonprofits/8", {
      method: "PATCH",
      headers: { "Content-Type": "application/json", Cookie: authCookie() },
      body: JSON.stringify({
        name: "After",
        grantAmount: 2500,
        grantStatus: "Pending",
      }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as InsertedNonprofit;
    expect(body.name).toBe("After");
    expect(body.grantAmount).toBe(2500);
    expect(body.grantStatus).toBe("Pending");
    // Untouched field keeps its original value.
    expect(body.contactEmail).toBe("before@example.org");
  });

  it("returns 400 when the patch contains an invalid email", async () => {
    nonprofitsAll.mockImplementation(() => [
      makeNonprofit({ id: 9, name: "V" }),
    ]);
    const res = await crm.request("/nonprofits/9", {
      method: "PATCH",
      headers: { "Content-Type": "application/json", Cookie: authCookie() },
      body: JSON.stringify({ contactEmail: "not-an-email" }),
    });
    expect(res.status).toBe(400);
  });
});

describe("DELETE /crm/nonprofits/:id", () => {
  it("returns 401 when no session cookie is present", async () => {
    const res = await crm.request("/nonprofits/1", { method: "DELETE" });
    expect(res.status).toBe(401);
    // Auth must gate the write before any row is touched.
    expect(deleteOps).toEqual([]);
  });

  it("returns 401 when the session is expired", async () => {
    nonprofitsAll.mockImplementation(() => [makeNonprofit({ id: 1 })]);
    const res = await crm.request("/nonprofits/1", {
      method: "DELETE",
      headers: { Cookie: authCookie({ expired: true }) },
    });
    expect(res.status).toBe(401);
    expect(deleteOps).toEqual([]);
  });

  it("returns 204 with an empty body on success", async () => {
    nonprofitsAll.mockImplementation(() => [
      makeNonprofit({ id: 7, name: "Gone" }),
    ]);
    const res = await crm.request("/nonprofits/7", {
      method: "DELETE",
      headers: { Cookie: authCookie() },
    });
    expect(res.status).toBe(204);
    expect(await res.text()).toBe("");
  });

  it("deletes dependent reports before the nonprofit itself", async () => {
    nonprofitsAll.mockImplementation(() => [makeNonprofit({ id: 7 })]);
    const res = await crm.request("/nonprofits/7", {
      method: "DELETE",
      headers: { Cookie: authCookie() },
    });
    expect(res.status).toBe(204);
    // Order matters: reports carry a NOT NULL FK to nonprofits, so the
    // parent row must go last or the delete strands/rejects.
    expect(deleteOps).toEqual([
      { table: "reports", id: 7 },
      { table: "nonprofits", id: 7 },
    ]);
  });

  it("returns 404 for an id that doesn't exist, without deleting anything", async () => {
    nonprofitsAll.mockImplementation(() => [makeNonprofit({ id: 7 })]);
    const res = await crm.request("/nonprofits/999", {
      method: "DELETE",
      headers: { Cookie: authCookie() },
    });
    expect(res.status).toBe(404);
    expect(deleteOps).toEqual([]);
  });

  it("returns 400 for a non-numeric id", async () => {
    const res = await crm.request("/nonprofits/abc", {
      method: "DELETE",
      headers: { Cookie: authCookie() },
    });
    expect(res.status).toBe(400);
    expect(deleteOps).toEqual([]);
  });

  it("returns 400 for a zero or negative id rather than treating it as a lookup", async () => {
    for (const bad of ["0", "-3"]) {
      const res = await crm.request(`/nonprofits/${bad}`, {
        method: "DELETE",
        headers: { Cookie: authCookie() },
      });
      expect(res.status).toBe(400);
    }
    expect(deleteOps).toEqual([]);
  });
});
