import { Hono } from "hono";
import { z } from "zod";
import { zValidator } from "@hono/zod-validator";
import { count, desc, eq, inArray } from "drizzle-orm";
import type { google } from "googleapis";
import { db } from "../db/client";
import { nonprofits, reports } from "../db/schema";
import { requireSession } from "../lib/session";
import { buildGmailQuery, extractBody, getHeader } from "../lib/gmail";
import { summarizeText } from "../lib/gemini";
import { sleep } from "../lib/utils";
import {
  beginCrmSync,
  completeCrmSync,
  failCrmSync,
  getCrmSyncJob,
  type CrmSyncError,
  type CrmSyncResult,
} from "../lib/crmSyncState";
import { logger } from "../logger";

// CRM (Foundation Management) routes.
//
// Surface:
//   - `GET|POST /crm/nonprofits`, `PATCH|DELETE /crm/nonprofits/:id` — directory CRUD
//   - `POST /crm/nonprofits/:id/sync`        — starts the Gmail → Gemini → `reports`
//                                              ingest, returns 202 immediately
//   - `GET  /crm/nonprofits/:id/sync-status` — progress/outcome of that run
//   - `GET  /crm/nonprofits/:id/reports`     — recorded correspondence, newest first

type GmailClient = ReturnType<typeof google.gmail>;

// `requireSession` (server/lib/session.ts) already builds an authenticated
// Gmail client and stashes it on the context, so the sync route below can
// read it straight off `c.get("gmailClient")` without re-doing the OAuth
// plumbing that server/routes/gmail.ts does in its own middleware.
const crm = new Hono<{ Variables: { gmailClient: GmailClient } }>();

// Called through a thunk rather than passed by reference.
//
// `crm.use("*", requireSession)` captures the function *value* at module
// evaluation time. Bun's `mock.module` patches a module's live bindings, but
// it cannot reach a reference another module already copied — so a test that
// mocks `../lib/session` would still run the production middleware here, and
// the mock would silently have no effect. (It looks like it works: the real
// 401 ladder is identical to the mocked one, so only a test needing the
// mocked `gmailClient` on the context notices.) Resolving the binding per
// request costs one property lookup and makes the mock actually apply.
crm.use("*", (c, next) => requireSession(c, next));

// Hard upper bound protects against an info-disclosure risk: an
// authenticated user dumping the whole partner roster by leaving the
// query params empty. Default 50, max 100. `offset` is 0-based.
const listQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

/**
 * Zod schema for POST /crm/nonprofits. Mirrors the column shape in
 * server/db/schema.ts exactly:
 *   - `name`             text NOT NULL
 *   - `contactEmail`     text (nullable in DB, so .optional() here)
 *   - `grantCycleDates`  text (nullable) — this column stores a single
 *                        free-form string ("2026-01 → 2026-12") rather
 *                        than separate start/end dates. The Zod schema
 *                        does NOT invent a richer date pair; passing
 *                        a user-supplied string straight through is
 *                        consistent with what CrmCard already renders.
 *   - `grantAmount`      real (nullable), positive when provided
 *   - `grantStatus`      text (nullable), free string — schema does
 *                        NOT constrain to an enum, so neither does this
 *
 * `.nullable().optional()` makes each field tolerant of both
 * `{ contactEmail: null }` and an omitted key, so the wire format
 * matches what the existing GET endpoint returns.
 */
const createNonprofitSchema = z.object({
  name: z.string().trim().min(1, "name is required"),
  contactEmail: z
    .string()
    .trim()
    .email("contactEmail must be a valid email")
    .nullable()
    .optional(),
  grantCycleDates: z
    .string()
    .trim()
    .min(1, "grantCycleDates cannot be blank when provided")
    .nullable()
    .optional(),
  grantAmount: z
    .number({ error: "grantAmount must be a number" })
    .positive("grantAmount must be positive")
    .finite("grantAmount must be finite")
    .nullable()
    .optional(),
  grantStatus: z
    .string()
    .trim()
    .min(1, "grantStatus cannot be blank when provided")
    .nullable()
    .optional(),
});

/**
 * PATCH variant: each field optional, but at least one must be present
 * (otherwise the request is a no-op and almost certainly a client bug).
 * `.refine` enforces the "≥ 1 field provided" rule after partial parsing.
 */
const updateNonprofitSchema = createNonprofitSchema
  .partial()
  .refine((data) => Object.values(data).some((v) => v !== undefined), {
    message: "At least one field must be provided",
  });

/**
 * Validate a `:id` route param as a positive integer. Mirrors the helper
 * in server/routes/portfolio.ts so both routes fail invalid ids
 * consistently with a 400.
 */
function parseNonprofitId(raw: string | undefined): number | null {
  if (raw == null) return null;
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) return null;
  return n;
}

/**
 * POST /crm/nonprofits
 *
 * Creates a new nonprofit. Auth is enforced globally for the /crm
 * mount via `crm.use("*", requireSession)` above, so this handler
 * inherits it without re-declaring. 201 returns the inserted row,
 * 400 is the default zValidator response on schema failure.
 *
 * No dedup pre-check here: the `nonprofits` schema has no UNIQUE
 * constraint other than the implicit row id. If the user later adds
 * one (e.g. on `name`), add the pre-check at that time.
 */
crm.post(
  "/nonprofits",
  zValidator("json", createNonprofitSchema),
  async (c) => {
    const body = c.req.valid("json");
    try {
      const inserted = await db
        .insert(nonprofits)
        .values({
          name: body.name,
          contactEmail: body.contactEmail ?? null,
          grantCycleDates: body.grantCycleDates ?? null,
          grantAmount: body.grantAmount ?? null,
          grantStatus: body.grantStatus ?? null,
        })
        .returning()
        .all();
      const row = inserted[0];
      if (!row) {
        return c.json({ message: "Insert returned no row" }, 500);
      }
      logger.info({
        method: "POST",
        path: "/crm/nonprofits",
        name: row.name,
      });
      return c.json(row, 201);
    } catch (error) {
      logger.error(
        { err: error, path: c.req.path },
        "Error inserting nonprofit",
      );
      return c.json({ message: "Error inserting nonprofit" }, 500);
    }
  },
);

/**
 * PATCH /crm/nonprofits/:id
 *
 * Partial update. Only the fields the client provided are written —
 * Drizzle's `.set(partial)` naturally drops undefined keys, so we
 * never overwrite unspecified columns with null/zero. 404 if the row
 * doesn't exist, 400 if the body is empty or invalid.
 *
 * Auth: inherited from `crm.use("*", requireSession)` above.
 */
crm.patch(
  "/nonprofits/:id",
  zValidator("json", updateNonprofitSchema),
  async (c) => {
    const id = parseNonprofitId(c.req.param("id"));
    if (id === null) {
      return c.json({ message: "Invalid id parameter" }, 400);
    }

    const body = c.req.valid("json");

    try {
      const existing = await db
        .select()
        .from(nonprofits)
        .where(eq(nonprofits.id, id))
        .get();
      if (!existing) {
        return c.json({ message: "Nonprofit not found" }, 404);
      }

      // Build a partial update object that drops any undefined entries so
      // unspecified fields keep their existing column value. The Zod
      // schema's `.refine` already guarantees ≥ 1 field is provided.
      const patch: Partial<{
        name: string;
        contactEmail: string | null;
        grantCycleDates: string | null;
        grantAmount: number | null;
        grantStatus: string | null;
      }> = {};
      if (body.name !== undefined) patch.name = body.name;
      if (body.contactEmail !== undefined)
        patch.contactEmail = body.contactEmail;
      if (body.grantCycleDates !== undefined)
        patch.grantCycleDates = body.grantCycleDates;
      if (body.grantAmount !== undefined) patch.grantAmount = body.grantAmount;
      if (body.grantStatus !== undefined) patch.grantStatus = body.grantStatus;

      const updated = await db
        .update(nonprofits)
        .set(patch)
        .where(eq(nonprofits.id, id))
        .returning()
        .all();
      const row = updated[0];
      if (!row) {
        // Race condition: row vanished between our select and our update.
        return c.json({ message: "Nonprofit not found" }, 404);
      }

      logger.info({
        method: "PATCH",
        path: "/crm/nonprofits/:id",
        id,
        fields: Object.keys(patch),
      });
      return c.json(row, 200);
    } catch (error) {
      logger.error(
        { err: error, path: c.req.path },
        "Error updating nonprofit",
      );
      return c.json({ message: "Error updating nonprofit" }, 500);
    }
  },
);

/**
 * DELETE /crm/nonprofits/:id
 *
 * Removes a nonprofit and its correspondence. 204 on success, 404 if the
 * row doesn't exist, 400 on a malformed id. Auth is inherited from
 * `crm.use("*", requireSession)` above.
 *
 * Cascade: `reports.nonprofitId` is a NOT NULL foreign key to this table,
 * so deleting a nonprofit outright would either fail (PRAGMA foreign_keys
 * = ON) or strand rows pointing at a dead id (pragma OFF — SQLite's
 * default, and what this app runs with). We delete the dependent reports
 * first so the outcome is the same either way. Mirrors the explicit
 * cascade in `DELETE /portfolio/investments/:id`; likewise no
 * `db.transaction`, since nothing else in this codebase uses one.
 */
crm.delete("/nonprofits/:id", async (c) => {
  const id = parseNonprofitId(c.req.param("id"));
  if (id === null) {
    return c.json({ message: "Invalid id parameter" }, 400);
  }

  try {
    const existing = await db
      .select()
      .from(nonprofits)
      .where(eq(nonprofits.id, id))
      .get();
    if (!existing) {
      return c.json({ message: "Nonprofit not found" }, 404);
    }

    await db.delete(reports).where(eq(reports.nonprofitId, id)).run();

    const deleted = await db
      .delete(nonprofits)
      .where(eq(nonprofits.id, id))
      .returning()
      .all();

    if (deleted.length === 0) {
      // Race: the row was removed between our select and our delete.
      // Report 404 for parity with the check above.
      return c.json({ message: "Nonprofit not found" }, 404);
    }

    logger.info({
      method: "DELETE",
      path: "/crm/nonprofits/:id",
      id,
    });
    return c.body(null, 204);
  } catch (error) {
    logger.error({ err: error, path: c.req.path }, "Error deleting nonprofit");
    return c.json({ message: "Error deleting nonprofit" }, 500);
  }
});

/**
 * GET /crm/nonprofits
 *
 * Returns one page of nonprofits ordered by name ASC plus a `total`
 * count of the entire table so the client can paginate without a
 * second request.
 */
crm.get("/nonprofits", zValidator("query", listQuerySchema), async (c) => {
  const { limit, offset } = c.req.valid("query");

  try {
    const rows = db
      .select()
      .from(nonprofits)
      .orderBy(nonprofits.name)
      .limit(limit)
      .offset(offset)
      .all();

    const totalRow = db.select({ c: count() }).from(nonprofits).get();
    const total = totalRow?.c ?? 0;

    return c.json({
      count: rows.length,
      total,
      limit,
      offset,
      nonprofits: rows,
    });
  } catch (error) {
    // Pino structured logging: lets the serializer escape the error
    // object rather than coercing it through `String(error)`, which
    // can paste raw SQL / parameter values (incl. nonprofit names)
    // into the log line.
    logger.error(
      { err: error, path: c.req.path },
      "Error fetching from nonprofits table",
    );
    return c.json({ message: "Error fetching nonprofits" }, 500);
  }
});

// ---------------------------------------------------------------------------
// Correspondence ingest: Gmail → Gemini → `reports`
// ---------------------------------------------------------------------------

// Per-sync ceiling on messages actually sent to Gemini. Deliberately low:
// this route holds the HTTP connection open for roughly
// `MAX_MESSAGES_PER_SYNC * GEMINI_THROTTLE_MS`, and it is driven by a button
// click rather than a background job. A sync that hits the cap is not lossy —
// already-stored messages are skipped before Gemini is called, so clicking
// "Refresh correspondence" again resumes where the previous run stopped.
const MAX_MESSAGES_PER_SYNC = 10;

// How many Gmail hits to consider per run before dedup. Larger than the
// Gemini cap so a mailbox with a long already-ingested backlog still finds
// the unseen messages hiding behind it.
const MAX_GMAIL_RESULTS = 50;

// Mirrors the cap in server/routes/summarize.ts — `body` is the field that
// actually reaches Gemini, so it carries the tighter bound.
const MAX_BODY_CHARS = 50_000;

// Gemini free-tier pacing, matching the default in server/routes/summarize.ts.
//
// This is a *minimum spacing between call starts*, not a fixed post-call
// sleep. Measured Gemini latency here is ~0.5s, so the old "call, then sleep
// 8s" shape produced 8.5s spacing and made the request 94% idle. Pacing from
// the previous call's start absorbs that latency into the interval instead of
// stacking on top of it, at exactly the same request rate.
//
// Read per call rather than cached at module load, for the same reason
// `sessionFilePath()` re-reads SESSION_FILE (see CLAUDE.md §6): a test can
// repoint it without depending on import order, which with Bun's hoisted,
// process-global `mock.module` is not something a test can reliably control.
// Also a genuine knob — a paid Gemini tier does not need an 8s gap.
const DEFAULT_GEMINI_THROTTLE_MS = 8000;

function geminiThrottleMs(): number {
  const raw = Number(process.env.CRM_SYNC_THROTTLE_MS);
  return Number.isFinite(raw) && raw >= 0 ? raw : DEFAULT_GEMINI_THROTTLE_MS;
}

/**
 * A run that failed as a whole, carrying the HTTP status the sync used to
 * answer with inline. Individual message failures are *not* this — they are
 * counted in `failed` and never abort the batch.
 */
class SyncFailure extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "SyncFailure";
  }
}

/** Narrow an unknown thrown value to the shape stored on the job. */
function toCrmSyncError(error: unknown): CrmSyncError {
  if (error instanceof SyncFailure) {
    return { message: error.message, status: error.status };
  }
  // Anything else is a bug rather than a known upstream condition, so keep the
  // detail in the log and hand the client a generic message.
  return {
    message: "Correspondence sync failed unexpectedly.",
    status: 500,
  };
}

const syncQuerySchema = z.object({
  // Gmail search window. Default 90 days: grant correspondence is sparse
  // enough that a 7-day window (the Advisor news default) would usually
  // return nothing at all.
  days: z.coerce.number().int().min(1).max(365).default(90),
});

const reportsQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

/**
 * Best-effort timestamp for a Gmail message.
 *
 * Prefers `internalDate` (epoch milliseconds as a string, always populated by
 * Gmail and unambiguous) over the free-form `Date:` header, which is
 * sender-supplied and can be malformed or in an unparseable timezone format.
 * Falls back to now so a weird message still lands in the table rather than
 * failing the NOT NULL constraint on `reports.date`.
 */
function messageDate(
  internalDate: string | null | undefined,
  dateHeader: string | undefined,
): Date {
  if (internalDate) {
    const ms = Number(internalDate);
    if (Number.isFinite(ms) && ms > 0) return new Date(ms);
  }
  if (dateHeader) {
    const parsed = new Date(dateHeader);
    if (!Number.isNaN(parsed.getTime())) return parsed;
  }
  return new Date();
}

/**
 * Did this Gmail call fail because the credentials are no longer good?
 *
 * Worth separating from a generic upstream failure: a 502 "could not read
 * Gmail" sends you looking for a Gmail or network fault, when the actual fix
 * is one click on "sign in again". googleapis surfaces the status
 * inconsistently across error shapes, so check all three places.
 */
function isGoogleAuthError(error: unknown): boolean {
  const e = error as {
    status?: number;
    code?: number | string;
    response?: { status?: number };
  };
  const status = e?.status ?? e?.response?.status ?? e?.code;
  return status === 401 || status === 403 || status === "401";
}

/**
 * Is this stored string usable as a Gmail `from:` operand?
 *
 * Deliberately loose — one `@`, no whitespace, a dot-bearing domain. The job
 * is to reject legacy placeholder text ("N/A", "N/A, # 212-243-7070"), not to
 * validate addresses to RFC 5322. The write routes already enforce a real
 * email via Zod; this guards the rows that predate them.
 */
function isLikelyEmail(value: string): boolean {
  return /^[^\s@]+@[^\s@.]+\.[^\s@]+$/.test(value.trim());
}

/**
 * Format a Date as Gmail's `after:` operand (YYYY/MM/DD).
 */
function gmailDateOperand(d: Date): string {
  return `${d.getUTCFullYear()}/${d.getUTCMonth() + 1}/${d.getUTCDate()}`;
}

/**
 * Gmail label the correspondence sync searches within.
 *
 * Scoping to a label rather than the whole mailbox is what keeps the ingest
 * honest: `from:` alone would sweep in anything that address ever sent,
 * including receipts, event invitations and thread replies that happen to
 * share the sender. Filing grantee mail under one label makes the label the
 * corpus and `from:` the selector that attributes each message to a grantee.
 *
 * Read per call (not cached at module load) so it can be repointed without a
 * restart, and overridable because label names are per-mailbox — a different
 * demo account may well not have one named "Nonprofit".
 */
function gmailLabel(): string {
  return process.env.CRM_GMAIL_LABEL?.trim() || "Nonprofit";
}

/**
 * Resolve a label's display name to its Gmail label id, or null if no label
 * by that name exists on the account.
 *
 * Gmail's message search takes labels two different ways, and only one of
 * them is reliable. The `label:Name` operator inside `q` matches on the
 * *display* name, which means it breaks on names containing spaces (they
 * need quoting) and on nested labels (which must be written `Parent/Child`).
 * `labelIds` takes the opaque id and has none of those failure modes.
 *
 * `server/routes/gmail.ts` — the Mail Brief path that has always worked —
 * uses `labelIds`, and `buildGmailQuery` there is deliberately called
 * *without* a label for exactly this reason. This does the same, resolving
 * the configured name to an id first so the CRM sync and Mail Brief agree on
 * what "a label" means.
 */
async function resolveLabelId(
  client: GmailClient,
  name: string,
): Promise<string | null> {
  const res = await client.users.labels.list({ userId: "me" });
  const wanted = name.trim().toLowerCase();
  const match = (res.data.labels ?? []).find(
    (l) => l.name?.trim().toLowerCase() === wanted,
  );
  return match?.id ?? null;
}

/**
 * The correspondence sync itself, run in the background by
 * `POST /crm/nonprofits/:id/sync`.
 *
 * Pulls recent mail *from* the nonprofit's `contactEmail` **within the
 * `Nonprofit` Gmail label**, summarises each previously-unseen message with
 * Gemini, and records it in `reports`.
 *
 * Throws `SyncFailure` when the run cannot proceed at all (bad credentials,
 * missing label, Gmail unreachable). A single message that fails to summarise
 * is counted in `failed` and never aborts the batch.
 *
 * Matching is on the exact `contactEmail` — these are organisational update
 * mails sent from a generic org address (`info@nonprofit.org`), so a domain
 * match would buy nothing here and would misfire on nonprofits that use a
 * shared consumer mail provider.
 *
 * A nonprofit whose mail has not been filed under the label returns zero
 * matches even when the address is correct — the label is a hard boundary,
 * not a ranking hint. See `gmailLabel()` for the override.
 *
 * Dedup runs **before** Gemini, not after. `reports.messageId` is UNIQUE, so
 * the insert alone would already make re-runs idempotent — but only after
 * paying a Gemini call plus an 8s throttle for every message already stored.
 * Pre-filtering is what makes a repeat sync near-instant instead of minutes.
 *
 * Note the UNIQUE is on `messageId` alone, *not* composite with
 * `nonprofitId` (unlike `newsItems`, which is deliberately composite). One
 * message therefore belongs to exactly one nonprofit, so the pre-check must
 * look across the whole table rather than scoping to this nonprofit —
 * otherwise a message already attributed elsewhere would survive the filter,
 * burn a Gemini call, and then fail the insert.
 */
async function runCorrespondenceSync(
  client: GmailClient,
  id: number,
  contactEmail: string,
  days: number,
): Promise<CrmSyncResult> {
  const labelName = gmailLabel();

  let labelId: string | null;
  try {
    labelId = await resolveLabelId(client, labelName);
  } catch (error) {
    logger.error(
      { err: error, nonprofitId: id },
      "Gmail label lookup failed during correspondence sync",
    );
    if (isGoogleAuthError(error)) {
      throw new SyncFailure(
        "Gmail authorisation has expired — sign in again.",
        401,
      );
    }
    throw new SyncFailure("Could not read Gmail labels", 502);
  }

  // Deliberately an error, not a fall-through to an unscoped search. With
  // `labelIds` omitted Gmail happily searches the entire mailbox, so a
  // typo'd or missing label would silently ingest every message that
  // address ever sent — the exact behaviour the label is here to prevent.
  if (!labelId) {
    throw new SyncFailure(
      `No Gmail label named "${labelName}" on this account. Create it (or set CRM_GMAIL_LABEL) and file grantee mail under it.`,
      422,
    );
  }

  const after = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  // Label goes through `labelIds` below, not the `label:` search operator —
  // see resolveLabelId. `buildGmailQuery` is called without one, matching
  // server/routes/gmail.ts.
  const q = buildGmailQuery({
    from: contactEmail,
    after: gmailDateOperand(after),
  });

  let candidates: Array<{ id?: string | null }>;
  try {
    const search = await client.users.messages.list({
      userId: "me",
      q,
      labelIds: [labelId],
      maxResults: MAX_GMAIL_RESULTS,
    });
    candidates = search.data.messages ?? [];
  } catch (error) {
    logger.error(
      { err: error, nonprofitId: id },
      "Gmail search failed during correspondence sync",
    );
    if (isGoogleAuthError(error)) {
      throw new SyncFailure(
        "Gmail authorisation has expired — sign in again.",
        401,
      );
    }
    throw new SyncFailure("Could not search Gmail", 502);
  }

  const candidateIds = candidates
    .map((m) => m.id)
    .filter((mid): mid is string => Boolean(mid));

  // Dedup pre-check. Empty `inArray` lists are invalid SQL in some
  // dialects, so short-circuit rather than issuing the query.
  let seen = new Set<string>();
  if (candidateIds.length > 0) {
    const stored = await db
      .select({ messageId: reports.messageId })
      .from(reports)
      .where(inArray(reports.messageId, candidateIds))
      .all();
    seen = new Set(stored.map((r) => r.messageId));
  }

  const unseen = candidateIds.filter((mid) => !seen.has(mid));
  const fresh = unseen.slice(0, MAX_MESSAGES_PER_SYNC);

  let summarized = 0;
  let failed = 0;
  // Messages this run actually started. Equal to `fresh.length` now that
  // nothing cuts the loop short, but kept distinct because it is what
  // `hasMore` genuinely means: everything unseen we never got to.
  let attempted = 0;

  const startedAt = Date.now();
  const throttleMs = geminiThrottleMs();
  // Start of the previous Gemini call, so pacing measures call-to-call
  // spacing rather than adding a fixed sleep on top of each call.
  let lastCallStartedAt: number | null = null;

  for (const messageId of fresh) {
    // No wall-clock budget: nothing is waiting on this loop. The request
    // that started it returned 202 long ago, so the run is free to take the
    // full `MAX_MESSAGES_PER_SYNC × throttle` it needs.
    if (attempted > 0 && lastCallStartedAt !== null) {
      // Wait only for the remainder of the interval since the last call
      // began, so Gemini's own latency counts toward the spacing instead of
      // stacking on top of it.
      const waitMs = Math.max(0, throttleMs - (Date.now() - lastCallStartedAt));
      if (waitMs > 0) await sleep(waitMs);
    }

    attempted += 1;

    try {
      const full = await client.users.messages.get({
        userId: "me",
        id: messageId,
        format: "full",
      });

      const payload = full.data.payload;
      const headers = (payload?.headers ?? []).filter(
        (h): h is { name: string; value: string } =>
          typeof h.name === "string" && typeof h.value === "string",
      );
      const body = payload ? extractBody(payload) : "";
      const content = (body || full.data.snippet || "").slice(
        0,
        MAX_BODY_CHARS,
      );

      lastCallStartedAt = Date.now();
      const summary = (await summarizeText(content)).trim();
      if (!summary) {
        // `reports.summary` is NOT NULL and an empty summary is worse
        // than no row — it looks like ingested-but-blank correspondence.
        throw new Error("Gemini returned an empty summary");
      }

      await db
        .insert(reports)
        .values({
          nonprofitId: id,
          messageId,
          summary,
          date: messageDate(full.data.internalDate, getHeader(headers, "Date")),
        })
        .run();

      summarized += 1;
    } catch (error) {
      // Per-message isolation, matching /summarize: one malformed message
      // or one Gemini hiccup must not abandon the rest of the batch.
      // Structured logging keeps the mail body out of a stringified error.
      failed += 1;
      logger.error(
        { err: error, nonprofitId: id, messageId },
        "Error summarizing correspondence",
      );
    }
  }

  // Anything unseen we never started — the count cap is the only thing that
  // stops us now — is still waiting for the next click.
  const hasMore = unseen.length > attempted;
  const elapsedMs = Date.now() - startedAt;

  logger.info({
    method: "POST",
    path: "/crm/nonprofits/:id/sync",
    nonprofitId: id,
    matched: candidateIds.length,
    skipped: candidateIds.length - unseen.length,
    attempted,
    summarized,
    failed,
    hasMore,
    elapsedMs,
  });

  return {
    nonprofitId: id,
    matched: candidateIds.length,
    // Messages that were already on file, so never sent to Gemini.
    skipped: candidateIds.length - unseen.length,
    summarized,
    failed,
    // Tells the UI another click will fetch more.
    hasMore,
  };
}

/**
 * POST /crm/nonprofits/:id/sync
 *
 * Starts a correspondence sync and returns **202 Accepted immediately**. The
 * run itself continues in the background; the client polls
 * `GET /crm/nonprofits/:id/sync-status` for progress and the final counts.
 *
 * Why 202 rather than the result
 * ------------------------------
 * Summarising N messages costs `N × throttle` seconds, which is longer than a
 * proxy will hold a connection open with no bytes flowing. Answering inline
 * meant the Codespaces port forwarder killed the request mid-run; its
 * header-less error response reads to the browser as a CORS failure, even
 * though the server went on to finish and commit every row. Returning at once
 * is what makes the request duration independent of the work. See
 * server/lib/crmSyncState.ts.
 *
 * What is still answered inline: everything that can be decided from the
 * database in microseconds — a malformed id (400), an unknown nonprofit (404),
 * and a row with no usable `contactEmail` (422). Those stay immediate so the
 * user gets an actionable message without a polling round-trip. Failures that
 * need Gmail — expired credentials, a missing label, an unreachable API —
 * surface through the job's `error` instead, carrying the same status codes.
 */
crm.post(
  "/nonprofits/:id/sync",
  zValidator("query", syncQuerySchema),
  async (c) => {
    const id = parseNonprofitId(c.req.param("id"));
    if (id === null) {
      return c.json({ message: "Invalid id parameter" }, 400);
    }

    const { days } = c.req.valid("query");

    const nonprofit = await db
      .select()
      .from(nonprofits)
      .where(eq(nonprofits.id, id))
      .get();
    if (!nonprofit) {
      return c.json({ message: "Nonprofit not found" }, 404);
    }
    // 422 rather than 400: the request is well-formed, the *stored row* is
    // what can't support the operation. The client shows this inline as
    // "add a contact email to sync correspondence".
    //
    // The shape check is not redundant with the NOT NULL / Zod-email
    // validation on the write routes: the seeded rows predate those routes
    // and several carry placeholders like "N/A, # 212-243-7070". Those are
    // truthy, so without this they would sail through into a Gmail query for
    // `from:N/A, # 212-243-7070` and come back with zero hits — reporting
    // "no mail found from this address", which reads as "this grantee has
    // been quiet" rather than "this row was never given an address".
    if (!nonprofit.contactEmail || !isLikelyEmail(nonprofit.contactEmail)) {
      return c.json(
        {
          message: nonprofit.contactEmail
            ? `"${nonprofit.contactEmail}" is not a usable email address, so there is no sender to match correspondence against`
            : "Nonprofit has no contactEmail, so there is no sender to match correspondence against",
        },
        422,
      );
    }

    // Already running: report the live job rather than starting a second
    // Gemini loop over the same mailbox. Still a 202 — from the client's point
    // of view "your sync is running" is true either way.
    if (!beginCrmSync(id)) {
      return c.json(
        { nonprofitId: id, status: "running" as const, alreadyRunning: true },
        202,
      );
    }

    // The Gmail client outlives this request, which is safe: `requireSession`
    // builds a standalone OAuth2 client per request and nothing about it is
    // tied to the response lifecycle. Its "tokens" listener writes refreshed
    // credentials straight back to the session store, so a refresh landing
    // mid-run is still persisted.
    const client = c.get("gmailClient");
    const contactEmail = nonprofit.contactEmail;

    // Deliberately not awaited — returning before this settles is the point.
    void runCorrespondenceSync(client, id, contactEmail, days)
      .then((result) => completeCrmSync(id, result))
      .catch((error: unknown) => {
        logger.error(
          { err: error, nonprofitId: id },
          "Correspondence sync run failed",
        );
        failCrmSync(id, toCrmSyncError(error));
      });

    return c.json(
      { nonprofitId: id, status: "running" as const, alreadyRunning: false },
      202,
    );
  },
);

/**
 * GET /crm/nonprofits/:id/sync-status
 *
 * Progress and outcome of the most recent sync for this nonprofit. `idle`
 * means none has run in this process — including after a restart, which
 * forgets in-flight jobs. That is cosmetic: whatever the lost run committed is
 * already in `reports` and visible through `GET .../reports`.
 *
 * Deliberately cheap and unconditional (no DB read): the client polls this
 * every couple of seconds while a run is in flight.
 */
crm.get("/nonprofits/:id/sync-status", (c) => {
  const id = parseNonprofitId(c.req.param("id"));
  if (id === null) {
    return c.json({ message: "Invalid id parameter" }, 400);
  }

  const job = getCrmSyncJob(id);
  if (!job) {
    return c.json({
      nonprofitId: id,
      status: "idle" as const,
      startedAt: null,
      finishedAt: null,
      result: null,
      error: null,
    });
  }

  // Serialise the timestamps explicitly — Hono's JSON encoder does not
  // special-case Date, the same trap `GET .../reports` handles below.
  return c.json({
    nonprofitId: job.nonprofitId,
    status: job.status,
    startedAt: job.startedAt.toISOString(),
    finishedAt: job.finishedAt ? job.finishedAt.toISOString() : null,
    result: job.result,
    error: job.error,
  });
});

/**
 * GET /crm/nonprofits/:id/reports
 *
 * One page of recorded correspondence for a nonprofit, newest first, plus a
 * `total` so the client can render "showing 10 of 34" without a second call.
 * Mirrors the pagination contract of `GET /crm/nonprofits`.
 */
crm.get(
  "/nonprofits/:id/reports",
  zValidator("query", reportsQuerySchema),
  async (c) => {
    const id = parseNonprofitId(c.req.param("id"));
    if (id === null) {
      return c.json({ message: "Invalid id parameter" }, 400);
    }

    const { limit, offset } = c.req.valid("query");

    try {
      const nonprofit = await db
        .select()
        .from(nonprofits)
        .where(eq(nonprofits.id, id))
        .get();
      if (!nonprofit) {
        return c.json({ message: "Nonprofit not found" }, 404);
      }

      const rows = await db
        .select()
        .from(reports)
        .where(eq(reports.nonprofitId, id))
        .orderBy(desc(reports.date))
        .limit(limit)
        .offset(offset)
        .all();

      const totalRow = await db
        .select({ c: count() })
        .from(reports)
        .where(eq(reports.nonprofitId, id))
        .get();
      const total = totalRow?.c ?? 0;

      return c.json({
        nonprofitId: id,
        count: rows.length,
        total,
        limit,
        offset,
        // `date` is a Drizzle timestamp column and deserialises to a Date.
        // Hono's JSON encoder does not special-case Date, so serialise
        // explicitly — same trap `toSnapshotDTO` handles in portfolio.ts.
        reports: rows.map((r) => ({
          id: r.id,
          nonprofitId: r.nonprofitId,
          messageId: r.messageId,
          summary: r.summary,
          date: r.date.toISOString(),
        })),
      });
    } catch (error) {
      logger.error({ err: error, path: c.req.path }, "Error fetching reports");
      return c.json({ message: "Error fetching reports" }, 500);
    }
  },
);

export default crm;
