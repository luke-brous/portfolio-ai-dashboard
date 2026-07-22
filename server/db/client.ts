import { drizzle } from "drizzle-orm/bun-sqlite";

// Single Drizzle client for the whole server. Exported standalone so route
// files can import it directly (`from "../db/client"`) without dragging
// server/index.ts into their module graph — which would create a circular
// import (`index.ts` mounts the routes, routes need `db`, `db` lives in
// `index.ts` → cycle). Importing `db` from `./db/client` keeps that graph
// a DAG.
export const db = drizzle(
    process.env.DB_FILE_NAME || "/workspaces/portfolio-ai-dashboard/sqlite.db",
);
