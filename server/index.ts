import "dotenv/config";
import { Hono } from "hono";
import { cors } from "hono/cors";
import auth from "./routes/auth";
import gmail from "./routes/gmail";
import summarize from "./routes/summarize";
import portfolio from "./routes/portfolio";
import crm from "./routes/crm";
import { logger } from "./logger";
import { requireSession } from "./lib/session";
import { syncMarketData } from "./db/syncMarketData";
import {
  getLastRun,
  isSyncInFlight,
  recordSyncFinish,
  recordSyncRun,
  recordSyncStart,
} from "./lib/syncState";

// Re-export `db` for backwards compatibility with callers that do
// `import { db } from "." / ".."` (syncMarketData.ts, seed.ts). New code
// should prefer importing from "./db/client" directly so the import graph
// stays a DAG — see server/db/client.ts.
export { db } from "./db/client";

const app = new Hono();

app.use(
  "*",
  cors({
    origin: process.env.CORS_ORIGIN ?? "http://localhost:5173",
    credentials: true,
  }),
);

app.use("*", async (c, next) => {
  const start = Date.now();
  await next();
  const ms = Date.now() - start;

  logger.info({
    method: c.req.method,
    path: c.req.path,
    status: c.res.status,
    duration: `${ms}ms`,
  });
});

// Inside server/index.ts
app.onError((err, c) => {
  logger.error(
    { err: err.message, path: c.req.path, query: c.req.query() },
    "uncaught error",
  ); // Log it securely on the backend
  return c.json({ message: "Internal Server Error" }, 500); // Return a generic error message to the client
});

app.get("/", (c) => c.text("Mail Brief API is running"));

app.route("/auth", auth);
app.route("/gmail", gmail);
app.route("/summarize", summarize);
app.route("/portfolio", portfolio);
app.route("/crm", crm);

// ---------------------------------------------------------------------------
// Scheduled Finnhub sync.
// Catches up on boot, then re-runs hourly. An in-flight flag
// (managed in server/lib/syncState.ts) prevents overlapping tickers.
// Set FINNHUB_SYNC_ENABLED=0 to disable (useful for tests/CI).
// ---------------------------------------------------------------------------

async function safeRunSync(): Promise<void> {
  if (isSyncInFlight()) {
    logger.info("[sync] Previous run still in progress — skipping this tick.");
    return;
  }
  recordSyncStart();
  try {
    const { tickersProcessed, tickersFailed, tickersSkipped } =
      await syncMarketData();
    const skipSuffix = tickersSkipped > 0 ? `, ${tickersSkipped} skipped` : "";
    const note =
      tickersFailed === 0
        ? `${tickersProcessed} ticker(s) ok${skipSuffix}`
        : `${tickersFailed} of ${tickersProcessed} ticker(s) failed${skipSuffix}`;
    recordSyncRun({
      at: new Date(),
      ok: tickersFailed === 0,
      note,
      tickersProcessed,
      tickersSkipped,
      tickersFailed,
    });
    logger.info(
      `[sync] Completed at ${getLastRun()!.at.toISOString()} — ${note}`,
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    recordSyncRun({ at: new Date(), ok: false, note: msg });
    logger.error(
      `[sync] Run failed at ${getLastRun()!.at.toISOString()}: ${msg}`,
    );
  } finally {
    recordSyncFinish();
  }
}

if (process.env.FINNHUB_SYNC_ENABLED !== "0") {
  // Catch up on boot. Deferred to the next tick so all module imports
  // (including the circular one between this file and db/syncMarketData.ts)
  // have fully resolved before we touch `db` or the table bindings.
  setTimeout(() => void safeRunSync(), 0);
  // Then hourly. `unref()` keeps the timer from holding the event loop open
  // past test / CLI runs.
  //
  // This is deliberately aligned with STALE_AFTER_MINUTES in
  // server/routes/portfolio.ts: a 1-hour "fresh" threshold on the dashboard
  // badge only carries signal if the sync actually runs hourly — on the old
  // 24h interval the badge would read red for ~23 hours a day. Cost is well
  // inside Finnhub's free tier (45 tickers x 2 calls x 24 runs/day against a
  // 60 req/min ceiling), and syncMarketData skips tickers that already have a
  // snapshot for today, so most of those runs do almost no work.
  const SYNC_INTERVAL_MS = 60 * 60 * 1000;
  const handle = setInterval(() => void safeRunSync(), SYNC_INTERVAL_MS);
  if (typeof handle.unref === "function") handle.unref();
  logger.info(
    "[sync] Finnhub sync scheduled (boot + hourly). Set FINNHUB_SYNC_ENABLED=0 to disable.",
  );
}

// Legacy status endpoint — shape preserved for the dashboard "last updated"
// widget. Do NOT add fields here; /portfolio/sync-status exposes the richer
// snapshot ({ lastRun, inFlight }) via getSyncSnapshot().
//
// Authed to match its twin: /portfolio/* is now behind `requireSession`, and
// leaving this open would be an unauthenticated read of the same state.
app.get("/sync/last-run", requireSession, (c) =>
  c.json({ lastRun: getLastRun(), inFlight: isSyncInFlight() }),
);

export default app;
