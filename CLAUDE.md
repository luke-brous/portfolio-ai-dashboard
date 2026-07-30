# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Git Workflow — Read First

**Never open a pull request unless explicitly told to.** The repo owner does all committing, pushing, and PR creation. Do not run `git commit`, `git push`, or `gh pr create` on your own initiative — not even at the end of a task that "feels done", and not because a branch looks ready.

Leave finished work as **uncommitted changes in the working checkout** and say what you changed. That is the deliverable.

Corollary: work in the checkout the dev server is actually running. A fix committed to a side branch or an isolated worktree does not reach `bun run dev`, so it will look like the fix silently did nothing.

## Project Overview

**Mail Brief** is a full-stack personal dashboard combining three major features:

1. **Mail Brief tab** — Gmail OAuth → Gemini summarization → React dashboard with CSV export
2. **Advisor Intelligence tab** — Daily Finnhub syncs of 45 portfolio tickers with price history and company news
3. **CRM tab** — Foundation/nonprofit correspondence tracking (Mail Brief logic adapted for multiple nonprofits)

The app is built with Bun (backend runtime), Hono (HTTP framework), React, Vite, and SQLite (Drizzle ORM).

## Technology Stack

**Backend:** Bun runtime, Hono framework, Drizzle ORM, SQLite (Bun's built-in driver), Zod validation, Pino logging
**Frontend:** React 18 + Vite + TypeScript, React Router v7, TanStack Query, Tailwind CSS (CDN)
**External:** Google OAuth 2.0 (Gmail API), Gemini API (gemini-3.1-flash-lite), Finnhub API (free tier 60 req/min)

## Essential Commands

```bash
# Install dependencies (root + client)
bun install && cd client && bun install && cd ..

# Development servers
bun run dev:server          # Backend on http://localhost:3000
bun run dev:client          # Frontend on http://localhost:5173 (needs separate terminal)
bun run dev                 # Both in parallel

# Database setup
npx drizzle-kit push       # Apply schema to SQLite
bun server/db/seed.ts --confirm  # Seed nonprofits + portfolio tickers

# Testing & quality
bun run test               # Run Bun test suite (server-side only)
bun run typecheck          # TypeScript check (tsc --noEmit)
bun run format             # Prettier format
bun run lint               # ESLint

# Environment
cp .env.example .env       # Fill in: GOOGLE_CLIENT_ID/SECRET, GEMINI_API_KEY, FINNHUB_API_KEY, DB_FILE_NAME, FRONTEND_URL
```

## Architecture Essentials

### Database Schema (server/db/schema.ts)

Four core tables drive the app:

- **nonprofits** — CRM foundations: name, contact email, grant cycle dates, amount/status
- **reports** — CRM correspondence: nonprofit FK, message ID (dedup), Gemini summary, date
- **investments** — Portfolio tickers: ticker, company name, sector, shares held
- **priceSnapshots** — Daily Finnhub pulls: investment FK, price/change/high/low/open/prevClose, timestamp
- **newsItems** — Company news from Finnhub: investment FK, headline, source, url, finnhub_id, timestamp
  - _Dedup boundary:_ composite unique index on (finnhub_id, investment_id) — one article can mention multiple held tickers

### Scheduled Sync (server/db/syncMarketData.ts, wired in server/index.ts)

- **Frequency:** Runs on boot, then every 24 hours via `setInterval(..., 24h).unref()`
- **What it does:** For each ticker, calls Finnhub `/quote` and last 7 days of `/company-news`, throttled at 2s (60 req/min free tier ceiling)
- **Idempotency:** Same-day snapshots skipped; news inserts via `INSERT OR IGNORE` on the composite unique index
- **Guard:** In-flight Promise prevents overlapping runs (server/lib/syncState.ts)
- **Control:** Set `FINNHUB_SYNC_ENABLED=0` to disable (tests, CI)

### Request Flow — Three Pipelines

**Pipeline 1: Mail Brief (Gmail → Gemini → React Dashboard)**

1. User OAuth login → session created in `server/lib/session.ts` (in-memory Map)
2. `GET /gmail/labels` → returns Gmail labels
3. User picks label + date range → `GET /gmail/messages` decodes raw emails
4. `POST /summarize` → calls Gemini once per email, returns structured summaries. Authed (`summarize.use("*", requireSession)`) and bounded: max 50 emails/request, 50k chars per `body`/`snippet`, 2k per header field. The 8s inter-call throttle is skipped after the final email. These caps exist because the route spends the server's Gemini quota and holds the connection open for its whole duration — don't raise them without thinking about both.
5. CSV export — **not implemented**. There is no `/export` route registered in `server/index.ts` and no `server/routes/export.ts` file. `client/vite.config.ts` still proxies `/export`, so the path is reserved but unbuilt.

**Pipeline 2: Advisor Intelligence (Finnhub Daily Sync → Local Read API)**

- `server/db/syncMarketData.ts` pulls quotes + news daily, writes to `priceSnapshots` and `newsItems`
- `GET /portfolio/investments` — joins with latest + previous snapshot for day-over-day delta
- `GET /portfolio/news?ticker=&days=N` — recent news for a ticker or full portfolio
- `GET /portfolio/sync-status` — returns last Finnhub run timestamp
- **Auth:** the whole mount is behind `portfolio.use("*", requireSession)` — reads included, since `GET /investments` returns share counts. Do not add an unauthenticated route here. The legacy twin `GET /sync/last-run` in `server/index.ts` is authed for the same reason.

**Pipeline 3: CRM (Nonprofits + Correspondence)**

- Similar to Mail Brief but scoped per nonprofit
- Routes: `GET|POST /crm/nonprofits`, `PATCH|DELETE /crm/nonprofits/:id` (see server/routes/crm.ts). `/crm/reports` is not implemented.
- `DELETE` cascades explicitly: `reports.nonprofitId` is a NOT NULL FK, so dependent reports are deleted first (SQLite runs with `PRAGMA foreign_keys` off by default, so nothing enforces this for us)
- Frontend: Pages under `/crm` route (in progress)

## File Organization

```
server/
├── index.ts                    # Entry point, route registration, Finnhub scheduler
├── logger.ts                   # Pino structured logging
├── db/
│   ├── client.ts              # Drizzle client (the canonical db import target)
│   ├── schema.ts              # Four core tables + indexes
│   ├── seed.ts                # Portfolio CSV parser, nonprofit seeder (gates with --confirm flag)
│   ├── syncMarketData.ts      # Finnhub pull worker (throttled, idempotent, guarded)
│   └── __tests__/
├── lib/
│   ├── google-client.ts       # OAuth2 client builder
│   ├── gmail.ts               # Base64 decode, header/body extraction
│   ├── gemini.ts              # Gemini API wrapper (free-tier aware)
│   ├── finnhub.ts             # /quote, /company-news calls (testable via __setFetchForTests)
│   ├── session.ts             # In-memory session store (lost on restart)
│   ├── syncState.ts           # In-flight run tracking, last-run snapshot
│   ├── utils.ts               # Helpers
│   └── __tests__/
├── routes/
│   ├── auth.ts                # /login, /callback (OAuth), /me (session check)
│   ├── gmail.ts               # /labels, /messages (Gmail API wrappers)
│   ├── summarize.ts           # /summarize (per-email Gemini calls)
│   ├── portfolio.ts           # /investments, /news, /sync-status (read API)
│   ├── crm.ts                 # /nonprofits CRUD (list/create/update/delete; /reports NOT implemented)
│   └── __tests__/
└── __tests__/
    ├── errorHandler.test.ts   # Global error handler sanitization
    └── finnhub_flow.test.ts   # End-to-end Finnhub → DB flow

client/
├── src/
│   ├── App.tsx                # Routes: /login, /dashboard, /advisor (WIP), /crm (WIP)
│   ├── pages/
│   │   ├── Login.tsx          # OAuth entry point
│   │   ├── Dashboard.tsx      # Mail Brief main view
│   │   ├── Advisor.tsx        # Portfolio (stub)
│   │   └── CRM.tsx            # Foundation management (stub)
│   ├── hooks/
│   │   ├── useAuth.ts         # GET /auth/me, session check
│   │   ├── useEmails.ts       # GET /gmail/messages orchestration
│   │   ├── useSummarize.ts    # POST /summarize
│   │   ├── useLabels.ts       # GET /gmail/labels
│   │   └── useNonProfits.ts   # CRM data (WIP)
│   ├── components/            # SummaryCard, DateRangePicker, LabelPicker, etc.
│   └── lib/
│       └── api.ts             # Relative-path fetch wrapper (uses Vite proxy)
```

## Critical Implementation Notes

### 0. CORS Origin

- `server/index.ts` reads `process.env.CORS_ORIGIN`, falling back to `http://localhost:5173`. It is **not** hardcoded to a Codespaces URL.
- Set `CORS_ORIGIN` to the deployed frontend origin in any non-local environment.

### 1. Environment Variables & DB Path (drizzle.config.ts vs. server/index.ts)

- `drizzle.config.ts` hardcodes DB path to `/workspaces/gmail-summarizer/sqlite.db` instead of reading `DB_FILE_NAME`
- **Risk:** `npx drizzle-kit push` silently operates on the wrong file if `DB_FILE_NAME` differs
- **Workaround:** Always set `DB_FILE_NAME` explicitly before running drizzle migrations

### 2. Circular Import Risk (server/db/client.ts)

- **Old pattern:** `server/index.ts` exports `db` → `syncMarketData.ts` imports from `..` → works only because `syncMarketData()` is called via deferred `setTimeout(..., 0)`
- **Mitigation:** Re-export from `server/index.ts` for backwards compatibility, but new code should import from `server/db/client.ts` directly
- **Future risk:** Eager imports (e.g., warm cache on startup) will cycle if not careful

### 3. Rate Limits & Finnhub Headroom

- Current sync uses 2 calls per ticker (quote + news) with 2s throttle
- Step 5 (filings + financials) will double this to 4 calls — current 2s sleep becomes uncomfortable on noisy networks
- **Action:** When filing detection lands, switch Finnhub client to token-bucket or 429-aware retry logic

### 4. Same-Day Snapshot Skip

- `syncMarketData.ts` skips re-pulling if a snapshot already exists for today
- **Risk:** A future refactor might re-add `await sleep()` to the skip branch, doubling sync time
- **Protection:** Step 5.3 of REWORK.md requires test coverage for this branch

### 5. News Dedup via Composite Index

- One Finnhub article can mention multiple held tickers — `newsItems` stores one row per (article, ticker) pair
- Dedup boundary is composite unique index on (finnhub_id, investment_id), not finnhub_id alone
- `INSERT OR IGNORE` in syncMarketData automatically respects this

### 6. Sessions & Restart Behavior

- Sessions stored in-memory Map (`server/lib/session.ts`), lost on backend restart
- OAuth tokens are refreshed automatically by Google's library (access_type: "offline")
- Expected behavior: Users stay logged in until server restarts

### 7. Frontend Vite Proxy vs. Direct VITE_BACKEND_URL

- `client/vite.config.ts` proxies `/auth`, `/gmail`, `/summarize`, `/export`, `/portfolio`, and `/crm` to the backend
- `/portfolio` and `/crm` **are** proxied — all client hooks use relative paths via `client/src/lib/api.ts`.
- **Invariant: never call `fetch` directly and never interpolate `VITE_BACKEND_URL` in a hook.** Go through `apiGet` / `apiPost` / `apiMutate`, which resolve the path against the backend origin in one place (`apiUrl`). The `sessionId` cookie is set by `/auth/callback` on the _backend_ origin and is host-only, so a call that leaks onto the frontend origin (a bare relative path when `VITE_BACKEND_URL` points elsewhere, as in Codespaces where :5173 and :3000 are separate hosts) arrives cookieless and 401s. This is exactly what broke the Advisor/CRM create forms: reads used the absolute backend URL, writes used relative paths, and at the time only the writes carried `requireSession` (all of `/portfolio/*` is authed now, so that asymmetry no longer masks the bug — a leaked path 401s immediately). Every hook now routes through `apiGet` / `apiMutate`; `Landing.tsx` and `Navbar.tsx` use `apiUrl` for their `window.location.replace` targets.
- If the client and API are genuinely cross-site, `SameSite=Lax` also drops the cookie on cross-site XHR. Set `SESSION_COOKIE_SAMESITE=none` (see `server/lib/cookieOptions.ts`) for that deployment shape.
- See README for env var guidance

## Testing Strategy

**Test coverage** (`bun run test`):

- `server/lib/gmail.ts` — base64url decoding, header parsing, body extraction
- `server/lib/syncState.ts` — in-flight guard, run recording, snapshot consistency
- `server/lib/finnhub.ts` — Finnhub client with mocked `fetch` via `__setFetchForTests` indirection
- `server/routes/*.ts` — Zod validation, OAuth middleware, mocked Gemini/Finnhub responses
- `server/db/syncMarketData.ts` — same-day skip, all-zero quote rejection, news idempotency, in-flight guard
- `server/__tests__/finnhub_flow.test.ts` — end-to-end Finnhub pull → DB insert

**CI runs** (`.github/workflows/test.yml`):

- `bun run typecheck`
- `bun run test`
- Note: `FINNHUB_API_KEY` and `GEMINI_API_KEY` **not** provided in CI — modules are stubbed

**Seed script idempotency** — `server/db/seed.ts` has a `--confirm` flag to prevent accidental data wipes. Running seed after a real Finnhub sync will clear that day's price history; use the flag to confirm intent.

## Known Limitations & Open Questions

**Limitations:**

- Sessions lost on backend restart (in-memory only)
- Sessions are not persisted (see above); `SESSION_SECRET` is declared in `.env.example` but read nowhere in the codebase
- Frontend uses CDN-bundled Tailwind (no PostCSS build), inline styles in components
- CSV export is not implemented at all — no route, no file (the Vite proxy entry for `/export` is vestigial)

**Open Questions** (see REWORK.md §5.4):

- **Scheduler:** Use `setInterval` (current) or real cron? (Matters for serverless)
- **Filings persistence:** New `filings` table or reuse `newsItems` with a `kind` column?
- **Last-seen state:** Local constant-on-disk or `last_filings_seen` table?
- **UI placement:** Where do filing insights appear — inline, separate panel, or new tab?

## Roadmap Status (REWORK.md §5)

| Step                 | Status         | File(s)                                                              |
| -------------------- | -------------- | -------------------------------------------------------------------- |
| 1. Schema & Seed     | ✅ Done        | `schema.ts`, `seed.ts`                                               |
| 2. Scheduled Fetch   | ✅ Done        | `syncMarketData.ts`, `server/index.ts`                               |
| 3. Read API          | ❌ Partial     | `server/routes/portfolio.ts` (routes exist but incomplete)           |
| 4. Advisor UI        | ❌ Not started | `client/src/pages/Advisor.tsx` (needs React components)              |
| 5. Filings detection | ❌ Not started | `server/lib/finnhub.ts` (need `getFilings`, `getFinancialsReported`) |
| 6. Gemini Insights   | ❌ Not started | Needs new `filing_insights` table, new Gemini prompt batching        |
| 7. CRM persistence   | ❌ Partial     | `reports` table exists, `/summarize` doesn't persist yet             |

## Worth Knowing

- **Gemini free tier:** Prompts may be used to improve Google's models — avoid sensitive nonprofit data without upgrade
- **Access token expiry:** ~1 hour, but Google OAuth library auto-refreshes via refresh_token (offline mode already enabled)
- **OAuth consent screen test mode:** Only Gmail accounts added as test users in Google Cloud Console can log in until screen is verified
- **Finnhub rate limit:** 60 requests/minute on free tier; current 2s throttle is comfortable for 2 calls per ticker

## graphify

This project has a knowledge graph at graphify-out/ with god nodes, community structure, and cross-file relationships.

Rules:

- For codebase questions, first run `graphify query "<question>"` when graphify-out/graph.json exists. Use `graphify path "<A>" "<B>"` for relationships and `graphify explain "<concept>"` for focused concepts. These return a scoped subgraph, usually much smaller than GRAPH_REPORT.md or raw grep output.
- If graphify-out/wiki/index.md exists, use it for broad navigation instead of raw source browsing.
- Read graphify-out/GRAPH_REPORT.md only for broad architecture review or when query/path/explain do not surface enough context.
- After modifying code, run `graphify update .` to keep the graph current (AST-only, no API cost).
