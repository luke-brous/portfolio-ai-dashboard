import { defineConfig } from 'drizzle-kit';
import "dotenv/config";

export default defineConfig({
  schema: './server/db/schema.ts',
  // schema: './db/schema.ts',

  out: './server/db/migrations',
  // out: './db/migrations',
  
  dialect: 'sqlite',
  dbCredentials: {
    url: process.env.DB_FILE_NAME || '/workspaces/gmail-summarizer/sqlite.db',
  },
});
