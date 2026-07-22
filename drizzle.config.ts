import { defineConfig } from 'drizzle-kit';
import "dotenv/config";

export default defineConfig({
  schema: './server/db/schema.ts',
  // schema: './db/schema.ts',

  out: './server/db/migrations',
  // out: './db/migrations',
  
  dialect: 'sqlite',
  dbCredentials: {
    //@ts-ignore
    url: process.env.DB_FILE_NAME || '/workspaces/portfolio-ai-dashboard/sqlite.db',
  },
});
