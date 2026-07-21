# Mail Brief

A full-stack personal dashboard for nonprofit correspondence and portfolio
intelligence.

- **Mail Brief tab** — Connect a Gmail account via OAuth, pick a label + date
  range, and Gemini summarizes each matching email into a short brief.
  Results live in a React dashboard and can be exported to CSV.
- **Advisor Intelligence tab** *(foundation only)* — Tracks ~45 stock tickers
  in a local SQLite database. The schema, the scheduled daily Finnhub price +
  news sync, and the read API (`/portfolio/investments`, `/portfolio/news`,
  `/portfolio/sync-status`) are wired up. The frontend tab itself, SEC
  filings detection, and Gemini-distilled filing insights are still pending
  — see [`REWORK.md`](./REWORK.md) §5 and [`advisor.md`](./advisor.md) for
  the plan.

The detail of how requests flow through the system is documented in
[`WORKFLOW.md`](./WORKFLOW.md). The broader roadmap is captured in
[`REWORK.md`](./REWORK.md).

## Stack

**Backend**
- [Bun](https://bun.sh) runtime + test runner
- [Hono](https://hono.dev) HTTP framework
- [Drizzle ORM](https://orm.drizzle.team) on SQLite (Bun's built-in driver)
- [Zod](https://zod.dev) (via `@hono/zod-validator`) for query/body validation
- [`googleapis`](https://www.npmjs.com/package/googleapis) + `google-auth-library` for OAuth + Gmail
- [`pino`](https://getpino.io) for structured logging

**Frontend**
- React 18 + [Vite](https://vitejs.dev) + TypeScript
- [`react-router-dom`](https://reactrouter.com) v7 for routing
- [`@tanstack/react-query`](https://tanstack.com/query) for fetching & caching
- [Tailwind CSS](https://tailwindcss.com) (loaded from the CDN in `index.html`)

**External APIs**
- Google OAuth 2.0 (`gmail.readonly` scope only)
- [Gemini](https://aistudio.google.com) — `gemini-3.1-flash-lite`
- [Finnhub](https://finnhub.io) — quotes and company news (free tier, 60 req/min)

## Prerequisites

You'll need accounts and credentials for each of the following:

1. **Google Cloud project** with the Gmail API enabled and an OAuth 2.0 *Web
   application* client ID. Add your redirect URI (see `.env.example` for the
   GitHub Codespaces format, or use `http://localhost:3000/auth/callback` for
   local dev).
2. **Gemini API key** — free at [aistudio.google.com](https://aistudio.google.com).
3. **Finnhub API key** — free at [finnhub.io](https://finnhub.io).
4. **Bun** installed locally (`curl -fsSL https://bun.sh/install | bash`).

## Status

**Beta** — the Mail Brief tab (Gmail → Gemini summarization → React dashboard)
is functional live: connect Gmail, pick a label + range, get Gemini
summaries rendered as cards, and export to CSV. Summaries are generated
per-request and held in React state only — `POST /summarize` does **not**
persist them to the `reports` table, so refreshing falls back to the raw
emails. The Advisor Intelligence tab has its foundation
in place: the `investments`, `price_snapshots`, and `news_items` schema and
seed data, the scheduled daily Finnhub sync (`server/db/syncMarketData.ts`),
the shared sync-state module (`server/lib/syncState.ts`), and the read API
under `server/routes/portfolio.ts` (`/investments`, `/news`,
`/sync-status`). What is **not** built yet:

- The Advisor Intelligence UI tab (no `/advisor` route in
  `client/src/App.tsx`, no read-API consumers in `client/src/hooks`).
- SEC filings detection (`/stock/filings`) and the `filings` /
  `filing_insights` / `last_filings_seen` tables.
- Gemini-distilled filing insights inside the sync pipeline.
- The CSV export route (`server/routes/export.ts`) — `GET /export/csv`
  still returns `"TODO: generate CSV export"`.

Known limitations:
- Sessions are stored in memory and lost on backend restart.
- The CORS origin is hardcoded to a specific GitHub Codespaces URL.
- `drizzle.config.ts` honours `DB_FILE_NAME` but falls back to a
  Codespace-specific absolute path (`/workspaces/gmail-summarizer/sqlite.db`)
  when the env var is unset. On a non-Codespace machine without
  `DB_FILE_NAME` set, `npx drizzle-kit push` will silently create a new DB
  at that path — set the env var explicitly.
- The frontend uses CDN-bundled Tailwind (no PostCSS build), inline styles
  in `SummaryCard.tsx`, and `ExportButton.tsx` has no Tailwind classes at
  all — fine for dev but not production-grade.

## Setup

```bash
# 1. Install dependencies (root + client)
bun install
cd client && bun install && cd ..

# 2. Configure environment
cp .env.example .env       # then fill in the values below

# 3. Initialize the SQLite database
npx drizzle-kit push        # creates tables from server/db/schema.ts

# 4. (Optional) Seed nonprofits + portfolio tickers
#    Requires: server/db/data/Portfolio Overview July 1st 2026.csv
#    (gitignored — your real portfolio file goes here)
bun server/db/seed.ts --confirm
```

### Environment variables

Set these in your `.env` (server-side) and in the client build if you use a
non-default backend origin.

**Server (`server/.env` or root `.env`)**

| Var | Purpose |
|---|---|
| `GOOGLE_CLIENT_ID` | OAuth 2.0 client ID from Google Cloud |
| `GOOGLE_CLIENT_SECRET` | OAuth 2.0 client secret |
| `GOOGLE_REDIRECT_URI` | Must match what you registered in Cloud Console |
| `GEMINI_API_KEY` | Gemini free-tier key |
| `FINNHUB_API_KEY` | Finnhub free-tier key |
| `DB_FILE_NAME` | Absolute path to your SQLite database file |
| `FRONTEND_URL` | Where to redirect after OAuth (default `http://localhost:5173`) |

**Client (`client/.env`)**

| Var | Purpose |
|---|---|
| `VITE_BACKEND_URL` | Absolute URL of the Hono backend. Required for hooks that read it directly (`useAuth`, `useEmails`, `useLabels`, `useSummarize`, plus manual fetches in `Dashboard.tsx`) — they construct URLs as `${VITE_BACKEND_URL}/...` with no fallback. Other call sites use `client/src/lib/api.ts`, which calls `fetch(path)` with a relative path and rides the Vite dev proxy. Note: `client/vite.config.ts`'s proxy map currently covers `/auth`, `/gmail`, `/summarize`, `/export` but **not** `/portfolio` — when the Advisor tab lands, those requests will bypass the proxy and must use `VITE_BACKEND_URL`. |

## Running the app

```bash
# Backend on http://localhost:3000
bun run dev:server

# Frontend on http://localhost:5173 (separate terminal)
bun run dev:client

# Run both in parallel
bun run dev
```

Open <http://localhost:5173> and click **Connect Gmail** to begin.

### Other scripts

| Script | Effect |
|---|---|
| `bun run typecheck` | `tsc --noEmit` over the server sources |
| `bun run test` | Bun test runner (server-side tests only) |
| `bun run format` | `bun format` over the codebase |
| `npx drizzle-kit push` | Apply `server/db/schema.ts` to the local SQLite file |
| `bunx @google/gemini-cli gemini` | Interactive Gemini CLI for repo reasoning |

## Project structure

```
gmail-summarizer/
├── .env.example
├── .gitignore
├── .github/
│   └── workflows/
│       └── test.yml
├── advisor.md            # (untracked) plan for the Advisor Intelligence tab
├── bun.lock
├── client/
│   ├── bun.lock
│   ├── index.html
│   ├── package.json
│   ├── src/
│   │   ├── App.tsx
│   │   ├── components/
│   │   │   ├── DateRangePicker.tsx
│   │   │   ├── EmailCardSkeleton.tsx
│   │   │   ├── ExportButton.tsx
│   │   │   ├── Footer.tsx
│   │   │   ├── LabelPicker.tsx
│   │   │   ├── Skeleton.tsx
│   │   │   └── SummaryCard.tsx
│   │   ├── hooks/
│   │   │   ├── useAuth.ts
│   │   │   ├── useEmails.ts
│   │   │   ├── useLabels.ts
│   │   │   └── useSummarize.ts
│   │   ├── index.css
│   │   ├── lib/
│   │   │   └── api.ts
│   │   ├── main.tsx
│   │   └── pages/
│   │       ├── Dashboard.tsx
│   │       └── Login.tsx
│   ├── tsconfig.json
│   ├── tsconfig.node.json
│   └── vite.config.ts
├── drizzle.config.ts
├── GEMINI.md
├── LICENSE
├── package.json
├── portfolio.md          # (untracked) notes on the Portfolio objects
├── README.md
├── REWORK.md
├── server/
│   ├── __tests__/
│   │   ├── errorHandler.test.ts
│   │   └── finnhub_flow.test.ts
│   ├── db/
│   │   ├── __tests__/
│   │   │   └── syncMarketData.test.ts
│   │   ├── client.ts
│   │   ├── data/
│   │   ├── schema.ts
│   │   ├── seed.ts
│   │   └── syncMarketData.ts
│   ├── index.ts
│   ├── lib/
│   │   ├── __tests__/
│   │   │   ├── gmail.test.ts
│   │   │   └── syncState.test.ts
│   │   ├── finnhub.ts
│   │   ├── gemini.ts
│   │   ├── gmail.ts
│   │   ├── google-client.ts
│   │   ├── session.ts
│   │   ├── syncState.ts
│   │   └── utils.ts
│   ├── logger.ts
│   ├── routes/
│   │   ├── __tests__/
│   │   │   ├── gmail.test.ts
│   │   │   ├── portfolio.test.ts
│   │   │   └── summarize.test.ts
│   │   ├── auth.ts
│   │   ├── export.ts
│   │   ├── gmail.ts
│   │   ├── portfolio.ts
│   │   └── summarize.ts
│   └── types/
│       ├── finnhub.ts
│       ├── gmail.ts
│       └── session.ts
├── tsconfig.json
└── WORKFLOW.md
```

## Tests

```bash
bun run test
```

The suite covers:
- `server/lib/gmail.ts` — base64url decoding, header lookups, body extraction
- `server/lib/syncState.ts` — start/finish/run recording, in-flight guard, snapshot consistency
- `server/lib/finnhub.ts` — feed via the `__setFetchForTests` indirection
- `server/routes/gmail.ts` — Zod validation, OAuth middleware integration
- `server/routes/summarize.ts` — request shape, mocked Gemini responses
- `server/routes/portfolio.ts` — investments delta math, news filtering, sync-status shape, error paths
- `server/db/syncMarketData.ts` — same-day skip, all-zero quote rejection, news idempotency, in-flight guard
- `server/index.ts` — global error handler sanitization (no stack-trace leak)
- `server/__tests__/finnhub_flow.test.ts` — end-to-end Finnhub pull into the DB

CI runs `bun run typecheck` and `bun run test` on every push and PR to
`main` (see `.github/workflows/test.yml`). Note: `FINNHUB_API_KEY` and
`GEMINI_API_KEY` are **not** provided in CI — the tests stub both modules.

## Worth knowing

- **Gemini's free tier may use your prompts to improve Google's models.**
  Since this app processes nonprofit partner correspondence, be aware that
  sensitive content in those emails should not be relied on the free tier
  long-term.
- **Access tokens expire (~1 hour).** The Google OAuth2 client automatically
  refreshes them using the stored `refresh_token`, as long as
  `access_type: "offline"` was requested at login (it is).
- **OAuth consent screen test mode.** Until the consent screen is verified
  by Google, only the Gmail accounts added as "test users" in Cloud Console
  can log in.

## License

See [`LICENSE`](./LICENSE).
