import { defineConfig } from "drizzle-kit";
import "dotenv/config";

const dbFileName = process.env.DB_FILE_NAME;

if (!dbFileName) {
  throw new Error("DB_FILE_NAME environment variable is not set");
}

export default defineConfig({
  schema: "./server/db/schema.ts",

  out: "./server/db/migrations",

  dialect: "sqlite",
  dbCredentials: {
    url: dbFileName,
  },
});
