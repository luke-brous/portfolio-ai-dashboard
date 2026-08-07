# Portfolio AI Dashboard

A personal-use web app that combines Gmail AI briefings, live market
intelligence, and nonprofit foundation management behind a single
Google-authenticated dashboard.

## Features

- **Mailbrief** — Pick a Gmail label and date range, then generate a bulk
  AI briefing of every thread in that window using Google Gemini.
- **Advisor** — Live portfolio holdings with latest prices, intraday
  delta vs. the previous snapshot, and recent per-ticker headlines.
  Quotes and news are pulled from Finnhub.
- **CRM** — Foundation management view of the nonprofits you fund,
  including grant cycles, amounts, and statuses. Server-paginated.
- **Auth** — Google OAuth; sessions are httpOnly cookies backed by an
  in-memory store with a server-side `expiresAt`.

## Tech stack

- **Runtime / package manager** — [Bun](https://bun.sh)
- **Backend** — [Hono](https://hono.dev), [Drizzle ORM](https://orm.drizzle.team)
  (SQLite via `bun-sqlite`), [Pino](https://getpino.io) logger,
  [Zod](https://zod.dev) validation, [`googleapis`](https://www.npmjs.com/package/googleapis)
  for Gmail.
- **Frontend** — React 18, Vite, React Router v7, TanStack Query.
- **Integrations** — Google (Gmail), Finnhub (quotes + company news),
  Google Gemini (email summarization).

## Repository layout

```
.
├── server/         # Hono API + SQLite + scheduled Finnhub sync
│   ├── routes/     # auth, gmail, summarize, portfolio, crm
│   ├── lib/        # gemini, finnhub, gmail, session, rateLimit, …
│   └── db/         # Drizzle schema + migrations + seed
└── client/         # Vite + React SPA
    └── src/
        ├── pages/  # Login, Landing, Home, Mailbrief, Advisor, CRM, NotFound
        ├── hooks/  # TanStack-Query data hooks (one per feature)
        └── components/
```

During development the Vite dev server proxies `/auth`, `/gmail`,
`/summarize`, `/portfolio`, and `/crm` through to the Bun backend on
port `3000` (see `client/vite.config.ts`).

## Prerequisites

- [Bun](https://bun.sh) — CI uses [`oven-sh/setup-bun@v2`](https://github.com/oven-sh/setup-bun) with `bun-version: latest`, and the lockfile is `bun@1.3.x`, so any current Bun works.
- A Google Cloud project with the Gmail API enabled and an OAuth 2.0
  **Web application** credential.
- A [Finnhub](https://finnhub.io) API key (free tier is sufficient).
- A [Google Gemini](https://aistudio.google.com) API key.

## Install

```bash
bun install
bun --cwd server install
bun --cwd client install
```

(Or just `bun install` at the root if your Bun handles nested
workspaces — both `server/` and `client/` have their own lockfiles.)

## Environment variables

Create a `.env` file at the project root. All server variables are
loaded by Bun via `dotenv`; the client variables are read by Vite at
build/dev time and must be prefixed with `VITE_`.

| Variable               | Used by         | Required | Purpose                                                                                                                                                                                   |
| ---------------------- | --------------- | -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `DB_FILE_NAME`         | server, Drizzle | ✅       | Path to the SQLite file. e.g. `./sqlite.db`. **Required** by `drizzle.config.ts` (no silent fallback).                                                                                    |
| `CORS_ORIGIN`          | server          | ❌       | Default `http://localhost:5173`.                                                                                                                                                          |
| `FRONTEND_URL`         | server (auth)   | ❌       | Where the auth callback redirects you. Default `http://localhost:5173`.                                                                                                                   |
| `GOOGLE_CLIENT_ID`     | server          | ✅       | OAuth client from Google Cloud.                                                                                                                                                           |
| `GOOGLE_CLIENT_SECRET` | server          | ✅       | OAuth client secret.                                                                                                                                                                      |
| `GOOGLE_REDIRECT_URI`  | server          | ✅       | Must match what you registered in Google Cloud (e.g. `http://localhost:3000/auth/callback`).                                                                                              |
| `GEMINI_API_KEY`       | server          | ✅       | Used by `/summarize`.                                                                                                                                                                     |
| `FINNHUB_API_KEY`      | server          | ✅       | Used by `/portfolio` + the background sync.                                                                                                                                               |
| `FINNHUB_SYNC_ENABLED` | server          | ❌       | Set to `0` to disable the boot + 24 h background sync (useful in CI / tests).                                                                                                             |
| `SEED_FILE`            | server (seed)   | ❌       | Reserved path for the per-user seed (`server/db/seed.ts`, gitignored). Not yet wired to a runner — invoke the seed manually. The shipping `seed_script.ts` only inserts placeholder rows. |
| `VITE_BACKEND_URL`     | client          | ✅       | Base URL of the Hono API. e.g. `http://localhost:3000`. Replaces proxy calls in production.                                                                                               |

## Development

```bash
bun run dev           # runs server (:3000) and client (:5173) in parallel
bun run dev:server    # bun --watch server/index.ts
bun run dev:client    # vite
```

Open <http://localhost:5173> and click **Connect Gmail** to start the
OAuth flow.

## Scripts

| Script                 | What it does                                  |
| ---------------------- | --------------------------------------------- |
| `bun run dev`          | Both server and client, side-by-side.         |
| `bun run dev:server`   | `bun --watch server/index.ts` on port `3000`. |
| `bun run dev:client`   | `vite` dev server on port `5173`.             |
| `bun run typecheck`    | `tsc --noEmit` across both workspaces.        |
| `bun run test`         | `bun test` for the whole repo.                |
| `bun run lint`         | ESLint (flat config) across the monorepo.     |
| `bun run format`       | Prettier write.                               |
| `bun run format:check` | Prettier check (used in CI).                  |

## Database

The schema lives in `server/db/schema.ts` and migrations are emitted
to `server/db/migrations/`.

```bash
# Generate a migration from a schema change
bunx drizzle-kit generate

# Apply the migration + open a SQLite shell manually if you need to
sqlite3 ./sqlite.db
```

Seeding:

```bash
# Placeholder seed that ships with the repo (requires --confirm)
bun server/db/seed_script.ts -- --confirm
```

The real per-user seed (`server/db/seed.ts`) is **gitignored** so the
public repo contains no personal data. Point `SEED_FILE` at it in your
local `.env` and invoke it however you prefer.

## Background sync

`server/index.ts` schedules `syncMarketData()` (defined in
`server/db/syncMarketData.ts`) on boot and hourly. The job:

- Fetches today's quote for every ticker in `investments`.
- Pulls the last 7 days of company news for each ticker.
- Uses a session-aware guard: refreshes a ticker at most hourly while the
  market is open (09:30–16:00 ET), takes one more pass after 16:00 to capture
  the closing price, then stays quiet overnight and at weekends (so reboots
  and off-hours ticks are cheap).
- Throttles to ~30 req/min — comfortably below Finnhub's free-tier
  60 req/min ceiling.
- Appends each outcome to the `sync_runs` table, so the dashboard's
  sync badge survives a restart instead of resetting to "Never synced".
- Records run results in `server/lib/syncState.ts` (`{ at, ok, note }`).

Inspect the current run state via:

```bash
curl http://localhost:3000/sync/last-run         # legacy dashboard widget
curl http://localhost:3000/portfolio/sync-status  # richer snapshot
```

Disable in CI / tests with `FINNHUB_SYNC_ENABLED=0`.

## API surface

| Method & path                            | Notes                                                                                                                                              |
| ---------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /`                                  | Health check → `text/plain`.                                                                                                                       |
| `GET /auth/login` → `GET /auth/callback` | Google OAuth flow (scope: `gmail.readonly`). Issues an httpOnly `sessionId` cookie on success (1 week).                                            |
| `GET /auth/me`                           | `{ authed: boolean }` liveness probe used by the SPA.                                                                                              |
| `GET /auth/logout`                       | Clears the server-side session + cookie, redirects to the frontend.                                                                                |
| `GET /gmail/labels`                      | List Gmail labels.                                                                                                                                 |
| `GET /gmail/messages`                    | List messages filtered by `label` + `after`/`before`/`from` (hard cap of 20 per call, returns decoded bodies).                                     |
| `POST /summarize`                        | Bulk-summarize an array of emails with Gemini.                                                                                                     |
| `GET /portfolio/investments`             | Holdings + latest + previous snapshot + delta (last vs. prev).                                                                                     |
| `GET /portfolio/news`                    | Recent news across holdings. Optional `?ticker=` (uppercased to match a held symbol) and `?days=N` (1–30, default 7, hard-capped at 200 rows).     |
| `GET /portfolio/sync-status`             | `{ lastRun, inFlight }` snapshot from `syncState`.                                                                                                 |
| `GET /sync/last-run`                     | Legacy endpoint kept for the dashboard "last updated" widget.                                                                                      |
| `GET /crm/nonprofits`                    | Paginated nonprofit list ordered by `name` ASC. `?limit=` (1–100, default 50) and `?offset=` (0-based, default 0); response also includes `total`. |

Sessions are required for everything under `/gmail`, `/summarize`,
`/portfolio`, and `/crm` — `server/lib/session.ts` returns a 401 with
the same message for missing cookies, unknown cookie values, and
expired sessions.

## CI

`.github/workflows/CI.yml` runs on push / PR to `main` and executes:

1. Root + server installs.
2. `bun run lint`
3. `bun run format:check`
4. `bun run typecheck`
5. `bun run test` (with `DB_FILE_NAME=sqlite.db`)

## License

MIT — see [`LICENSE`](./LICENSE).
