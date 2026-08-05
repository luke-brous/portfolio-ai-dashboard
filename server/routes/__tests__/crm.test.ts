import { describe, it, expect, mock, beforeEach, afterAll } from "bun:test";
import { getCookie } from "hono/cookie";
import type { Context, Next } from "hono";
import crypto from "crypto";
import * as drizzleOrm from "drizzle-orm";

import crm from "../crm";
import { nonprofits, reports } from "../../db/schema";
import { createSession } from "../../lib/session";
import {
  getCrmSyncJob,
  resetCrmSyncStateForTesting,
  type CrmSyncJob,
  type CrmSyncResult,
} from "../../lib/crmSyncState";
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
    // Production `requireSession` builds an OAuth'd Gmail client and stashes
    // it here; `POST /nonprofits/:id/sync` reads it off the context. The
    // fake below stands in for the googleapis client — without it the sync
    // route would throw on `c.get("gmailClient")` rather than exercise the
    // ingest logic under test.
    c.set("gmailClient", fakeGmailClient);
    await next();
  },
}));

// ---------- Gemini mock -----------------------------------------------------------
//
// The route calls `summarizeText` once per unseen message. Returning a
// deterministic string lets the assertions pin exactly which messages were
// summarised, and `summarizeCalls` records the content passed in so a test
// can prove dedup happened *before* Gemini was spent rather than after.

const summarizeCalls: string[] = [];
let summarizeImpl: (content: string) => Promise<string> = (content) =>
  Promise.resolve(`summary of: ${content.slice(0, 40)}`);

mock.module("../../lib/gemini", () => ({
  summarizeText: (content: string) => {
    summarizeCalls.push(content);
    return summarizeImpl(content);
  },
}));

// ---------- Gmail client fake -----------------------------------------------------

type FakeMessage = {
  id: string;
  internalDate?: string;
  snippet?: string;
  dateHeader?: string;
  bodyText?: string;
};

let gmailMessages: FakeMessage[] = [];
let gmailListError: Error | null = null;
/** Every `q` string the route handed to Gmail, so tests can assert the filter. */
const gmailQueries: string[] = [];
/** Every `labelIds` array the route handed to Gmail. */
const gmailLabelIds: Array<string[] | undefined> = [];
/**
 * Labels the fake account has. Mirrors the real `/gmail/labels` shape
 * ({ id, name }) — the route resolves a display name to an id against this.
 */
let gmailLabels: Array<{ id: string; name: string }> = [];
let gmailLabelsError: Error | null = null;

function base64url(s: string): string {
  return Buffer.from(s, "utf-8")
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
}

const fakeGmailClient = {
  users: {
    labels: {
      list: () => {
        if (gmailLabelsError) return Promise.reject(gmailLabelsError);
        return Promise.resolve({ data: { labels: gmailLabels } });
      },
    },
    messages: {
      list: (params: {
        q?: string;
        maxResults?: number;
        labelIds?: string[];
      }) => {
        gmailQueries.push(params.q ?? "");
        gmailLabelIds.push(params.labelIds);
        if (gmailListError) return Promise.reject(gmailListError);
        return Promise.resolve({
          data: {
            messages: gmailMessages
              .slice(0, params.maxResults ?? gmailMessages.length)
              .map((m) => ({ id: m.id })),
          },
        });
      },
      get: (params: { id: string }) => {
        const m = gmailMessages.find((x) => x.id === params.id);
        if (!m)
          return Promise.reject(new Error(`no such message ${params.id}`));
        return Promise.resolve({
          data: {
            internalDate: m.internalDate,
            snippet: m.snippet,
            payload: {
              mimeType: "text/plain",
              headers: m.dateHeader
                ? [{ name: "Date", value: m.dateHeader }]
                : [],
              body: { data: base64url(m.bodyText ?? "") },
            },
          },
        });
      },
    },
  },
};

const nonprofitsAll = mock(() => [] as Array<typeof nonprofits.$inferSelect>);

// Verifiable insert/update audit so each test can assert on what the
// production handler actually wrote without re-reading rows out of a
// shared mocked table. `updateOps` is keyed by id and stores the
// cumulative patch (PATCH calls are observed destructured into the row).
const deleteOps: Array<{ table: "nonprofits" | "reports"; id: number }> = [];

// Stand-in `reports` table. Unlike `nonprofitsAll` (a read-only fixture), this
// one is written to by the sync route under test, so it is a plain mutable
// array reset in `beforeEach`.
type ReportRow = typeof reports.$inferSelect;
const reportsStore: ReportRow[] = [];
const reportsAll = () => reportsStore;

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
      // Call shapes that hit the route:
      //   1. db.select({ c: count() }).from(nonprofits).get()      → total
      //   2. db.select({ c: count() }).from(reports)
      //            .where(eq(nonprofitId, X)).get()                 → report total
      //   3. db.select().from(<table>).where(eq(<id>, X)).get()     → lookup by id
      //   4. db.select().from(nonprofits).orderBy(<col>)
      //            .limit(N).offset(M).all()                        → page
      //   5. db.select().from(reports).where(eq(nonprofitId, X))
      //            .orderBy(desc(date)).limit(N).offset(M).all()     → report page
      //   6. db.select({ messageId }).from(reports)
      //            .where(inArray(messageId, [...])).all()           → dedup pre-check
      const isCount = Boolean(opts && typeof opts === "object" && "c" in opts);
      const isMessageIdProjection = Boolean(
        opts && typeof opts === "object" && "messageId" in opts,
      );

      if (isCount) {
        return {
          from: (table: unknown) => {
            if (table === nonprofits) {
              return { get: () => ({ c: nonprofitsAll().length }) };
            }
            if (table === reports) {
              return {
                where: (condition: unknown) => {
                  const eq = asMockedEq(condition);
                  if (!eq || eq.col !== reports.nonprofitId) {
                    throw new Error(
                      `Unexpected reports count condition: ${String(condition)}`,
                    );
                  }
                  return {
                    get: () => ({
                      c: reportsAll().filter((r) => r.nonprofitId === eq.val)
                        .length,
                    }),
                  };
                },
              };
            }
            throw new Error(`Unexpected count table: ${String(table)}`);
          },
        };
      }

      if (isMessageIdProjection) {
        return {
          from: (table: unknown) => {
            if (table !== reports) {
              throw new Error(
                `messageId projection from unexpected table: ${String(table)}`,
              );
            }
            return {
              // The condition here is a real `inArray(...)` (the drizzle mock
              // only replaces `eq`), so there is no token to destructure.
              // Returning every stored messageId is a faithful stand-in: the
              // route only uses the result to build a "already seen" Set, and
              // any stored report genuinely *is* already seen. A superset
              // cannot change the outcome for ids that aren't in it.
              where: () => ({
                all: () =>
                  reportsAll().map((r) => ({ messageId: r.messageId })),
              }),
            };
          },
        };
      }

      return {
        from: (table: unknown) => {
          if (table === reports) {
            return {
              where: (condition: unknown) => {
                const eq = asMockedEq(condition);
                if (!eq || eq.col !== reports.nonprofitId) {
                  throw new Error(
                    `Unexpected reports where condition: ${String(condition)}`,
                  );
                }
                const mine = reportsAll().filter(
                  (r) => r.nonprofitId === eq.val,
                );
                return {
                  orderBy: () => ({
                    limit: (n: number) => ({
                      offset: (o: number) => ({
                        all: () =>
                          [...mine]
                            .sort((a, b) => b.date.getTime() - a.date.getTime())
                            .slice(o, o + n),
                      }),
                    }),
                  }),
                };
              },
            };
          }
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
      if (table === reports) {
        return {
          // The sync route inserts with `.run()` — it has no use for the
          // written row. Pushing into `reportsStore` makes the insert visible
          // to the very next `GET /nonprofits/:id/reports` in the same test,
          // and enforcing the UNIQUE on `messageId` here means a test that
          // breaks dedup fails loudly instead of silently double-recording.
          values: (record: Record<string, unknown>) => ({
            run: () => {
              const messageId = String(record.messageId);
              if (reportsStore.some((r) => r.messageId === messageId)) {
                throw new Error(
                  `UNIQUE constraint failed: reports.message_id (${messageId})`,
                );
              }
              reportsStore.push({
                id: 900 + reportsStore.length,
                nonprofitId: Number(record.nonprofitId),
                messageId,
                summary: String(record.summary),
                date: record.date as Date,
              });
            },
          }),
        };
      }
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
  reportsStore.length = 0;
  summarizeCalls.length = 0;
  gmailQueries.length = 0;
  gmailLabelIds.length = 0;
  gmailMessages = [];
  gmailListError = null;
  gmailLabelsError = null;
  // The account has the label by default; tests that care remove it.
  gmailLabels = [
    { id: "Label_7", name: "Nonprofit" },
    { id: "Label_9", name: "Grantees" },
    { id: "INBOX", name: "INBOX" },
  ];
  summarizeImpl = (content) =>
    Promise.resolve(`summary of: ${content.slice(0, 40)}`);
  // Collapse the 8s inter-message Gemini throttle. Without this a
  // multi-message sync test would take over a minute of pure sleeping.
  process.env.CRM_SYNC_THROTTLE_MS = "0";
  // Belt-and-braces: the override tests clean up in a `finally`, but a leak
  // here would silently retarget every other sync test's Gmail query.
  delete process.env.CRM_GMAIL_LABEL;
  // Job state is module-level and per-process, so a leftover "running" job
  // from a previous test would make the next `beginCrmSync` refuse to start.
  resetCrmSyncStateForTesting();
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

// ---------- Correspondence ingest -------------------------------------------------

/** Convenience: a nonprofit that can actually be synced. */
function syncableNonprofit(
  overrides: Partial<NonprofitRow> = {},
): NonprofitRow {
  return makeNonprofit({
    id: 1,
    name: "Riverside Trust",
    contactEmail: "info@riverside.org",
    ...overrides,
  });
}

function makeGmailMessage(
  id: string,
  overrides: Partial<FakeMessage> = {},
): FakeMessage {
  return {
    id,
    internalDate: String(Date.UTC(2026, 5, 1)),
    bodyText: `Newsletter body ${id}`,
    ...overrides,
  };
}

/**
 * Start a sync. The route hands the run to the background and returns
 * straight away, so this resolves long before any Gmail or Gemini work.
 */
async function startSync(id = 1, query = ""): Promise<Response> {
  return crm.request(`/nonprofits/${id}/sync${query}`, {
    method: "POST",
    headers: { Cookie: authCookie() },
  });
}

/**
 * Block until the background job settles.
 *
 * Every assertion about Gmail calls, Gemini calls or written reports has to go
 * through here: the 202 says only that the run was accepted, so asserting
 * straight off the response would race the work.
 */
async function waitForSync(id = 1, timeoutMs = 5_000): Promise<CrmSyncJob> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const job = getCrmSyncJob(id);
    if (job && job.status !== "running") return job;
    if (Date.now() > deadline) {
      throw new Error(
        `sync job for nonprofit ${id} did not settle within ${timeoutMs}ms`,
      );
    }
    // 1ms, not a coarser tick: the pacing test measures elapsed time across
    // this wait, so polling granularity shows up directly in its budget.
    await new Promise((r) => setTimeout(r, 1));
  }
}

/**
 * A promise the test resolves by hand.
 *
 * Tests that need a run to still be in flight must hold it open explicitly
 * rather than leaning on the Gemini throttle: `server/db/__tests__/
 * syncMarketData.test.ts` mocks `../lib/utils`, and Bun's `mock.module` is
 * process-global and permanent (see CLAUDE.md), so in a combined run `sleep`
 * is a no-op here and a "slow" run finishes in microtasks.
 */
function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = () => r();
  });
  return { promise, resolve };
}

/** Start a sync, assert it was accepted, and wait for the run to finish. */
async function syncAndWait(id = 1, query = ""): Promise<CrmSyncJob> {
  const res = await startSync(id, query);
  expect(res.status).toBe(202);
  return waitForSync(id);
}

/** As above, for a run expected to succeed — returns its counts. */
async function completedSync(id = 1, query = ""): Promise<CrmSyncResult> {
  const job = await syncAndWait(id, query);
  if (job.status !== "done" || !job.result) {
    throw new Error(
      `expected a completed run, got "${job.status}": ${job.error?.message ?? "no error recorded"}`,
    );
  }
  return job.result;
}

describe("POST /crm/nonprofits/:id/sync", () => {
  it("returns 401 without a session", async () => {
    const res = await crm.request("/nonprofits/1/sync", { method: "POST" });
    expect(res.status).toBe(401);
  });

  it("rejects a non-integer id with 400", async () => {
    const res = await crm.request("/nonprofits/abc/sync", {
      method: "POST",
      headers: { Cookie: authCookie() },
    });
    expect(res.status).toBe(400);
  });

  it("returns 404 when the nonprofit does not exist", async () => {
    const res = await crm.request("/nonprofits/99/sync", {
      method: "POST",
      headers: { Cookie: authCookie() },
    });
    expect(res.status).toBe(404);
  });

  it("returns 422 when the nonprofit has no contactEmail", async () => {
    nonprofitsAll.mockImplementation(() => [
      makeNonprofit({ id: 1, contactEmail: null }),
    ]);
    const res = await startSync();
    expect(res.status).toBe(422);
    // Nothing should have been spent — or even scheduled — for a row that
    // can't be synced.
    expect(summarizeCalls).toEqual([]);
    expect(gmailQueries).toEqual([]);
    expect(getCrmSyncJob(1)).toBeNull();
  });

  it("returns 422 for a legacy placeholder contactEmail instead of searching", async () => {
    // Seeded rows predate the Zod-validated write routes and carry values
    // like "N/A, # 212-243-7070". Truthy, but not a sender.
    nonprofitsAll.mockImplementation(() => [
      makeNonprofit({ id: 1, contactEmail: "N/A, # 212-243-7070" }),
    ]);
    const res = await startSync();
    expect(res.status).toBe(422);
    expect(gmailQueries).toEqual([]);
    expect(summarizeCalls).toEqual([]);
    expect(getCrmSyncJob(1)).toBeNull();
  });

  it('returns 422 for a bare "N/A" contactEmail', async () => {
    nonprofitsAll.mockImplementation(() => [
      makeNonprofit({ id: 1, contactEmail: "N/A" }),
    ]);
    const res = await startSync();
    expect(res.status).toBe(422);
    expect(gmailQueries).toEqual([]);
  });

  it("rejects an out-of-range `days` window with 400", async () => {
    nonprofitsAll.mockImplementation(() => [syncableNonprofit()]);
    const res = await startSync(1, "?days=9999");
    expect(res.status).toBe(400);
  });

  // ---- acceptance: the request must not wait for the run --------------------

  it("returns 202 immediately instead of holding the connection for the run", async () => {
    // The bug this whole shape exists to kill: a request pinned to the Gemini
    // throttle stayed silent long enough for the proxy in front of the app to
    // give up, which surfaced in the browser as a CORS error while the server
    // quietly finished the work anyway.
    nonprofitsAll.mockImplementation(() => [syncableNonprofit()]);
    gmailMessages = Array.from({ length: 12 }, (_, i) =>
      makeGmailMessage(`m${i}`),
    );
    // Pin the run open on the very first summary so the assertions below are
    // about ordering, not wall-clock luck.
    const gate = deferred();
    summarizeImpl = async (content) => {
      await gate.promise;
      return `summary of: ${content.slice(0, 40)}`;
    };

    const res = await startSync();

    expect(res.status).toBe(202);
    expect(await jsonBody(res)).toMatchObject({
      nonprofitId: 1,
      status: "running",
      alreadyRunning: false,
    });

    // The load-bearing assertion: the response came back while the run was
    // demonstrably unfinished, so the request cannot have been waiting on it.
    expect(getCrmSyncJob(1)?.status).toBe("running");
    expect(reportsStore).toHaveLength(0);

    // ...and the run genuinely continues after the response.
    gate.resolve();
    const job = await waitForSync();
    expect(job.status).toBe("done");
    expect(job.result).toMatchObject({ summarized: 10 });
  });

  it("does not start a second run while one is already in flight", async () => {
    // An impatient double-click must not put two Gemini loops on the same
    // mailbox — they would race on dedup and double-spend the quota.
    nonprofitsAll.mockImplementation(() => [syncableNonprofit()]);
    gmailMessages = [
      makeGmailMessage("m1"),
      makeGmailMessage("m2"),
      makeGmailMessage("m3"),
    ];
    const gate = deferred();
    summarizeImpl = async () => {
      await gate.promise;
      return "ok summary";
    };

    const first = await startSync();
    expect(await jsonBody(first)).toMatchObject({ alreadyRunning: false });

    // The first run is provably still going — it is blocked on `gate`.
    const second = await startSync();
    expect(second.status).toBe(202);
    expect(await jsonBody(second)).toMatchObject({ alreadyRunning: true });

    gate.resolve();
    await waitForSync();
    // One run, not two: each message summarised exactly once.
    expect(summarizeCalls).toHaveLength(3);
    expect(reportsStore).toHaveLength(3);
  });

  it("allows a fresh run once the previous one has settled", async () => {
    nonprofitsAll.mockImplementation(() => [syncableNonprofit()]);
    gmailMessages = [makeGmailMessage("m1")];
    await completedSync();

    gmailMessages = [makeGmailMessage("m1"), makeGmailMessage("m2")];
    const second = await completedSync();
    expect(second).toMatchObject({ skipped: 1, summarized: 1 });
  });

  // ---- label scoping (decided inside the run) ------------------------------

  it("scopes the search by labelIds, not the `label:` query operator", async () => {
    nonprofitsAll.mockImplementation(() => [syncableNonprofit()]);
    await syncAndWait();
    expect(gmailQueries).toHaveLength(1);
    // Label travels as an id, matching server/routes/gmail.ts. Putting it in
    // `q` instead would break on names with spaces or nested Parent/Child.
    expect(gmailLabelIds[0]).toEqual(["Label_7"]);
    expect(gmailQueries[0]).not.toContain("label:");
    // `from:` still selects which grantee within the label.
    expect(gmailQueries[0]).toContain("from:info@riverside.org");
    // The default window is 90 days, expressed as Gmail's after: operand.
    expect(gmailQueries[0]).toMatch(/after:\d{4}\/\d{1,2}\/\d{1,2}/);
  });

  it("matches the label name case-insensitively", async () => {
    gmailLabels = [{ id: "Label_42", name: "  nonprofit " }];
    nonprofitsAll.mockImplementation(() => [syncableNonprofit()]);
    await syncAndWait();
    expect(gmailLabelIds[0]).toEqual(["Label_42"]);
  });

  it("honours a CRM_GMAIL_LABEL override", async () => {
    process.env.CRM_GMAIL_LABEL = "Grantees";
    try {
      nonprofitsAll.mockImplementation(() => [syncableNonprofit()]);
      await syncAndWait();
      expect(gmailLabelIds[0]).toEqual(["Label_9"]);
    } finally {
      delete process.env.CRM_GMAIL_LABEL;
    }
  });

  it("falls back to the Nonprofit label when the override is blank", async () => {
    process.env.CRM_GMAIL_LABEL = "   ";
    try {
      nonprofitsAll.mockImplementation(() => [syncableNonprofit()]);
      await syncAndWait();
      expect(gmailLabelIds[0]).toEqual(["Label_7"]);
    } finally {
      delete process.env.CRM_GMAIL_LABEL;
    }
  });

  it("fails the run with 422 when the account has no such label, rather than searching everything", async () => {
    // The dangerous alternative: omitting labelIds makes Gmail search the
    // whole mailbox, silently ingesting far more than intended.
    gmailLabels = [{ id: "INBOX", name: "INBOX" }];
    nonprofitsAll.mockImplementation(() => [syncableNonprofit()]);

    const job = await syncAndWait();

    expect(job.status).toBe("error");
    expect(job.error).toMatchObject({
      status: 422,
      message: expect.stringContaining("Nonprofit"),
    });
    expect(gmailQueries).toEqual([]);
    expect(summarizeCalls).toEqual([]);
  });

  // ---- upstream failures now surface on the job ----------------------------

  it("maps expired credentials on the label lookup to a 401 job error", async () => {
    // A 502 sends you hunting for a Gmail outage; the real fix is to sign in
    // again. googleapis puts the status in different places by error shape,
    // so cover the `response.status` form here and the bare `code` form next.
    gmailLabelsError = Object.assign(new Error("Invalid Credentials"), {
      response: { status: 401 },
    });
    nonprofitsAll.mockImplementation(() => [syncableNonprofit()]);

    const job = await syncAndWait();

    expect(job.status).toBe("error");
    expect(job.error).toMatchObject({
      status: 401,
      message: expect.stringContaining("sign in again"),
    });
  });

  it("maps expired credentials on the message search to a 401 job error", async () => {
    gmailListError = Object.assign(new Error("Invalid Credentials"), {
      code: 401,
    });
    nonprofitsAll.mockImplementation(() => [syncableNonprofit()]);

    const job = await syncAndWait();
    expect(job.error).toMatchObject({ status: 401 });
  });

  it("reports a failed label lookup as a 502 job error", async () => {
    gmailLabelsError = new Error("Gmail 503");
    nonprofitsAll.mockImplementation(() => [syncableNonprofit()]);

    const job = await syncAndWait();
    expect(job.status).toBe("error");
    expect(job.error).toMatchObject({ status: 502 });
    expect(gmailQueries).toEqual([]);
  });

  it("reports a failed Gmail search as a 502 job error", async () => {
    nonprofitsAll.mockImplementation(() => [syncableNonprofit()]);
    gmailListError = new Error("Gmail 503");

    const job = await syncAndWait();
    expect(job.status).toBe("error");
    expect(job.error).toMatchObject({ status: 502 });
    expect(summarizeCalls).toEqual([]);
  });

  // ---- ingest behaviour ----------------------------------------------------

  it("summarizes new messages and records them against the nonprofit", async () => {
    nonprofitsAll.mockImplementation(() => [syncableNonprofit()]);
    gmailMessages = [makeGmailMessage("m1"), makeGmailMessage("m2")];

    expect(await completedSync()).toMatchObject({
      nonprofitId: 1,
      matched: 2,
      skipped: 0,
      summarized: 2,
      failed: 0,
      hasMore: false,
    });

    expect(reportsStore).toHaveLength(2);
    expect(reportsStore.map((r) => r.messageId).sort()).toEqual(["m1", "m2"]);
    expect(reportsStore.every((r) => r.nonprofitId === 1)).toBe(true);
    expect(reportsStore[0]!.summary).toContain("Newsletter body");
  });

  it("skips already-recorded messages BEFORE calling Gemini", async () => {
    nonprofitsAll.mockImplementation(() => [syncableNonprofit()]);
    reportsStore.push({
      id: 1,
      nonprofitId: 1,
      messageId: "m1",
      summary: "already on file",
      date: new Date("2026-05-01T00:00:00Z"),
    });
    gmailMessages = [makeGmailMessage("m1"), makeGmailMessage("m2")];

    expect(await completedSync()).toMatchObject({
      matched: 2,
      skipped: 1,
      summarized: 1,
    });
    // The whole point of the pre-check: exactly one Gemini call, for m2 only.
    expect(summarizeCalls).toHaveLength(1);
    expect(summarizeCalls[0]).toContain("m2");
  });

  it("is idempotent — a second identical sync spends nothing and adds nothing", async () => {
    nonprofitsAll.mockImplementation(() => [syncableNonprofit()]);
    gmailMessages = [makeGmailMessage("m1")];

    await completedSync();
    expect(reportsStore).toHaveLength(1);
    expect(summarizeCalls).toHaveLength(1);

    expect(await completedSync()).toMatchObject({
      matched: 1,
      skipped: 1,
      summarized: 0,
    });
    expect(reportsStore).toHaveLength(1);
    expect(summarizeCalls).toHaveLength(1);
  });

  it("dedups against messages already attributed to a DIFFERENT nonprofit", async () => {
    // `reports.messageId` is UNIQUE on its own, not composite with
    // nonprofitId, so a message stored elsewhere must not be re-summarized
    // here — it would burn a Gemini call and then fail the insert.
    nonprofitsAll.mockImplementation(() => [
      syncableNonprofit({ id: 2, name: "Second Trust" }),
    ]);
    reportsStore.push({
      id: 1,
      nonprofitId: 1,
      messageId: "m1",
      summary: "recorded against nonprofit 1",
      date: new Date("2026-05-01T00:00:00Z"),
    });
    gmailMessages = [makeGmailMessage("m1")];

    expect(await completedSync(2)).toMatchObject({
      skipped: 1,
      summarized: 0,
    });
    expect(summarizeCalls).toEqual([]);
  });

  it("caps a run at 10 messages and reports hasMore", async () => {
    nonprofitsAll.mockImplementation(() => [syncableNonprofit()]);
    gmailMessages = Array.from({ length: 12 }, (_, i) =>
      makeGmailMessage(`m${i}`),
    );

    expect(await completedSync()).toMatchObject({
      matched: 12,
      summarized: 10,
      hasMore: true,
    });
    expect(reportsStore).toHaveLength(10);
  });

  it("resumes from where the message cap stopped the previous run", async () => {
    nonprofitsAll.mockImplementation(() => [syncableNonprofit()]);
    gmailMessages = Array.from({ length: 12 }, (_, i) =>
      makeGmailMessage(`m${i}`),
    );

    expect(await completedSync()).toMatchObject({ summarized: 10 });
    // The stored ten are skipped; the remaining two are picked up.
    expect(await completedSync()).toMatchObject({
      skipped: 10,
      summarized: 2,
      hasMore: false,
    });
    expect(reportsStore).toHaveLength(12);
    expect(new Set(reportsStore.map((r) => r.messageId)).size).toBe(12);
  });

  it("summarises the whole batch instead of cutting the run short on time", async () => {
    // Regression guard for the removed wall-clock budget. The old shape
    // stopped mid-batch to keep the response under a proxy timeout; nothing is
    // waiting on the connection now, so a slow run must still finish the work.
    process.env.CRM_SYNC_THROTTLE_MS = "40";
    nonprofitsAll.mockImplementation(() => [syncableNonprofit()]);
    gmailMessages = Array.from({ length: 5 }, (_, i) =>
      makeGmailMessage(`m${i}`),
    );

    expect(await completedSync()).toMatchObject({
      matched: 5,
      summarized: 5,
      hasMore: false,
    });
    expect(reportsStore).toHaveLength(5);
  });

  it("hasMore is false when the run drained everything unseen", async () => {
    nonprofitsAll.mockImplementation(() => [syncableNonprofit()]);
    gmailMessages = [makeGmailMessage("m1"), makeGmailMessage("m2")];

    expect(await completedSync()).toMatchObject({
      summarized: 2,
      hasMore: false,
    });
  });

  it("paces from the start of the previous call rather than adding a fixed sleep", async () => {
    // Gemini latency should be absorbed by the interval, not stacked on top:
    // a call slower than the throttle means no sleeping at all.
    process.env.CRM_SYNC_THROTTLE_MS = "40";
    nonprofitsAll.mockImplementation(() => [syncableNonprofit()]);
    gmailMessages = [
      makeGmailMessage("m1"),
      makeGmailMessage("m2"),
      makeGmailMessage("m3"),
    ];
    summarizeImpl = async () => {
      await new Promise((r) => setTimeout(r, 60));
      return "slow summary";
    };

    const started = Date.now();
    await syncAndWait();
    const elapsed = Date.now() - started;

    expect(reportsStore).toHaveLength(3);
    // 3 calls x 60ms = 180ms of real work. The old fixed-sleep shape would
    // have added 2 x 40ms on top (~260ms). Generous ceiling to stay stable
    // on a loaded CI box while still failing the stacked-sleep behaviour.
    expect(elapsed).toBeLessThan(250);
  });

  it("isolates a single message failure without abandoning the batch", async () => {
    nonprofitsAll.mockImplementation(() => [syncableNonprofit()]);
    gmailMessages = [makeGmailMessage("m1"), makeGmailMessage("m2")];
    summarizeImpl = (content) =>
      content.includes("m1")
        ? Promise.reject(new Error("Gemini exploded"))
        : Promise.resolve("ok summary");

    // A per-message failure is counted, not escalated: the run still "done".
    expect(await completedSync()).toMatchObject({ summarized: 1, failed: 1 });
    expect(reportsStore.map((r) => r.messageId)).toEqual(["m2"]);
  });

  it("treats an empty Gemini summary as a failure rather than storing a blank row", async () => {
    nonprofitsAll.mockImplementation(() => [syncableNonprofit()]);
    gmailMessages = [makeGmailMessage("m1")];
    summarizeImpl = () => Promise.resolve("   ");

    expect(await completedSync()).toMatchObject({ summarized: 0, failed: 1 });
    expect(reportsStore).toHaveLength(0);
  });

  it("prefers internalDate over the free-form Date header", async () => {
    nonprofitsAll.mockImplementation(() => [syncableNonprofit()]);
    const internal = Date.UTC(2026, 2, 14);
    gmailMessages = [
      makeGmailMessage("m1", {
        internalDate: String(internal),
        dateHeader: "not a parseable date",
      }),
    ];

    await syncAndWait();

    expect(reportsStore[0]!.date.getTime()).toBe(internal);
  });

  it("falls back to the Date header when internalDate is absent", async () => {
    nonprofitsAll.mockImplementation(() => [syncableNonprofit()]);
    gmailMessages = [
      makeGmailMessage("m1", {
        internalDate: undefined,
        dateHeader: "Sat, 14 Mar 2026 09:30:00 +0000",
      }),
    ];

    await syncAndWait();

    expect(reportsStore[0]!.date.toISOString()).toBe(
      "2026-03-14T09:30:00.000Z",
    );
  });
});

describe("GET /crm/nonprofits/:id/sync-status", () => {
  it("returns 401 without a session", async () => {
    const res = await crm.request("/nonprofits/1/sync-status");
    expect(res.status).toBe(401);
  });

  it("rejects a non-integer id with 400", async () => {
    const res = await crm.request("/nonprofits/abc/sync-status", {
      headers: { Cookie: authCookie() },
    });
    expect(res.status).toBe(400);
  });

  it("reports `idle` when no run has happened in this process", async () => {
    // Deliberately not a 404: "nothing has run" is a normal state for a panel
    // opening for the first time, and after a restart it is also what a
    // finished-but-forgotten run looks like.
    const res = await crm.request("/nonprofits/1/sync-status", {
      headers: { Cookie: authCookie() },
    });
    expect(res.status).toBe(200);
    expect(await jsonBody(res)).toMatchObject({
      nonprofitId: 1,
      status: "idle",
      startedAt: null,
      finishedAt: null,
      result: null,
      error: null,
    });
  });

  it("reports `running` while the job is in flight, then `done` with counts", async () => {
    nonprofitsAll.mockImplementation(() => [syncableNonprofit()]);
    gmailMessages = [makeGmailMessage("m1"), makeGmailMessage("m2")];
    const gate = deferred();
    summarizeImpl = async () => {
      await gate.promise;
      return "ok summary";
    };

    await startSync();

    const during = (await (
      await crm.request("/nonprofits/1/sync-status", {
        headers: { Cookie: authCookie() },
      })
    ).json()) as { status: string; startedAt: string | null };
    expect(during.status).toBe("running");
    // Serialised explicitly — Hono's JSON encoder does not special-case Date.
    expect(typeof during.startedAt).toBe("string");

    gate.resolve();
    await waitForSync();

    const after = (await (
      await crm.request("/nonprofits/1/sync-status", {
        headers: { Cookie: authCookie() },
      })
    ).json()) as {
      status: string;
      finishedAt: string | null;
      result: CrmSyncResult | null;
    };
    expect(after.status).toBe("done");
    expect(typeof after.finishedAt).toBe("string");
    expect(after.result).toMatchObject({
      nonprofitId: 1,
      matched: 2,
      summarized: 2,
      hasMore: false,
    });
  });

  it("exposes a failed run with the status the inline route would have used", async () => {
    gmailLabels = [{ id: "INBOX", name: "INBOX" }];
    nonprofitsAll.mockImplementation(() => [syncableNonprofit()]);

    await syncAndWait();

    const res = await crm.request("/nonprofits/1/sync-status", {
      headers: { Cookie: authCookie() },
    });
    expect(await jsonBody(res)).toMatchObject({
      status: "error",
      result: null,
      error: { status: 422 },
    });
  });

  it("keeps each nonprofit's job separate", async () => {
    nonprofitsAll.mockImplementation(() => [
      syncableNonprofit({ id: 1 }),
      syncableNonprofit({ id: 2, name: "Second Trust" }),
    ]);
    gmailMessages = [makeGmailMessage("m1")];

    await completedSync(1);

    const other = await crm.request("/nonprofits/2/sync-status", {
      headers: { Cookie: authCookie() },
    });
    expect(await jsonBody(other)).toMatchObject({
      nonprofitId: 2,
      status: "idle",
    });
  });
});

describe("GET /crm/nonprofits/:id/reports", () => {
  it("returns 401 without a session", async () => {
    const res = await crm.request("/nonprofits/1/reports");
    expect(res.status).toBe(401);
  });

  it("rejects a non-integer id with 400", async () => {
    const res = await crm.request("/nonprofits/abc/reports", {
      headers: { Cookie: authCookie() },
    });
    expect(res.status).toBe(400);
  });

  it("returns 404 when the nonprofit does not exist", async () => {
    const res = await crm.request("/nonprofits/99/reports", {
      headers: { Cookie: authCookie() },
    });
    expect(res.status).toBe(404);
  });

  it("returns the documented envelope when there is no correspondence", async () => {
    nonprofitsAll.mockImplementation(() => [syncableNonprofit()]);
    const res = await crm.request("/nonprofits/1/reports", {
      headers: { Cookie: authCookie() },
    });
    expect(res.status).toBe(200);
    expect(await jsonBody(res)).toEqual({
      nonprofitId: 1,
      count: 0,
      total: 0,
      limit: 50,
      offset: 0,
      reports: [],
    });
  });

  it("returns reports newest first with ISO dates", async () => {
    nonprofitsAll.mockImplementation(() => [syncableNonprofit()]);
    reportsStore.push(
      {
        id: 1,
        nonprofitId: 1,
        messageId: "old",
        summary: "older update",
        date: new Date("2026-01-01T00:00:00Z"),
      },
      {
        id: 2,
        nonprofitId: 1,
        messageId: "new",
        summary: "newer update",
        date: new Date("2026-06-01T00:00:00Z"),
      },
    );

    const res = await crm.request("/nonprofits/1/reports", {
      headers: { Cookie: authCookie() },
    });
    const body = (await jsonBody(res)) as {
      count: number;
      total: number;
      reports: Array<{ messageId: string; date: string }>;
    };

    expect(body.count).toBe(2);
    expect(body.total).toBe(2);
    expect(body.reports.map((r) => r.messageId)).toEqual(["new", "old"]);
    // Dates must be ISO strings — Hono's encoder does not serialise Date.
    expect(body.reports[0]!.date).toBe("2026-06-01T00:00:00.000Z");
  });

  it("does not leak another nonprofit's correspondence", async () => {
    nonprofitsAll.mockImplementation(() => [
      syncableNonprofit({ id: 1 }),
      syncableNonprofit({ id: 2, name: "Second Trust" }),
    ]);
    reportsStore.push(
      {
        id: 1,
        nonprofitId: 1,
        messageId: "mine",
        summary: "for 1",
        date: new Date("2026-01-01T00:00:00Z"),
      },
      {
        id: 2,
        nonprofitId: 2,
        messageId: "theirs",
        summary: "for 2",
        date: new Date("2026-01-02T00:00:00Z"),
      },
    );

    const res = await crm.request("/nonprofits/1/reports", {
      headers: { Cookie: authCookie() },
    });
    const body = (await jsonBody(res)) as {
      total: number;
      reports: Array<{ messageId: string }>;
    };

    expect(body.total).toBe(1);
    expect(body.reports.map((r) => r.messageId)).toEqual(["mine"]);
  });

  it("paginates with limit/offset while reporting the full total", async () => {
    nonprofitsAll.mockImplementation(() => [syncableNonprofit()]);
    for (let i = 0; i < 5; i++) {
      reportsStore.push({
        id: i + 1,
        nonprofitId: 1,
        messageId: `m${i}`,
        summary: `update ${i}`,
        date: new Date(Date.UTC(2026, 0, i + 1)),
      });
    }

    const res = await crm.request("/nonprofits/1/reports?limit=2&offset=1", {
      headers: { Cookie: authCookie() },
    });
    const body = (await jsonBody(res)) as {
      count: number;
      total: number;
      limit: number;
      offset: number;
      reports: Array<{ messageId: string }>;
    };

    expect(body).toMatchObject({ count: 2, total: 5, limit: 2, offset: 1 });
    // Newest first: m4, m3, m2, m1, m0 — offset 1 takes m3 and m2.
    expect(body.reports.map((r) => r.messageId)).toEqual(["m3", "m2"]);
  });

  it("rejects an over-max limit with 400", async () => {
    nonprofitsAll.mockImplementation(() => [syncableNonprofit()]);
    const res = await crm.request("/nonprofits/1/reports?limit=500", {
      headers: { Cookie: authCookie() },
    });
    expect(res.status).toBe(400);
  });
});
