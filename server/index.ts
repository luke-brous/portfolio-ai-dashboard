import "dotenv/config";
import { Hono } from "hono";
import { cors } from "hono/cors";
import auth from "./routes/auth";
import gmail from "./routes/gmail";
import summarize from "./routes/summarize";
import exportRoute from "./routes/export";
import portfolio from "./routes/portfolio";
import { logger } from "./logger";
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
    origin:
      "https://opulent-space-happiness-g45wwqj7pjwq3v56w-5173.app.github.dev",
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
app.route("/export", exportRoute);
app.route("/portfolio", portfolio);

// ---------------------------------------------------------------------------
// Scheduled Finnhub sync.
// Catches up on boot, then re-runs every 24 hours. An in-flight flag
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
    recordSyncRun({ at: new Date(), ok: tickersFailed === 0, note });
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
  // Then every 24 hours. `unref()` keeps the timer from holding the event
  // loop open past test / CLI runs.
  const SYNC_INTERVAL_MS = 24 * 60 * 60 * 1000;
  const handle = setInterval(() => void safeRunSync(), SYNC_INTERVAL_MS);
  if (typeof handle.unref === "function") handle.unref();
  logger.info(
    "[sync] Finnhub sync scheduled (boot + every 24h). Set FINNHUB_SYNC_ENABLED=0 to disable.",
  );
}

// Legacy status endpoint — shape preserved for the dashboard "last updated"
// widget. Do NOT add fields here; /portfolio/sync-status exposes the richer
// snapshot ({ lastRun, inFlight }) via getSyncSnapshot().
app.get("/sync/last-run", (c) =>
  c.json({ lastRun: getLastRun(), inFlight: isSyncInFlight() }),
);

export default app;
