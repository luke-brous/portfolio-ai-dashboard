import { Hono } from "hono";

const exportRoute = new Hono();

// accept the current summaries (from query/session/cache) and
// return them as a CSV file with Content-Type: text/csv.
exportRoute.get("/csv", (c) => {
  return c.text("TODO: generate CSV export");
});

export default exportRoute;
