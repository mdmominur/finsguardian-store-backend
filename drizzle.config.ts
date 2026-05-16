import { defineConfig } from 'drizzle-kit';

export default defineConfig({
  // Use tables directly so drizzle-kit can load TS without ESM ".js" specifiers.
  schema: './src/db/schema/tables.ts',
  out: './drizzle',
  dialect: 'postgresql',
  dbCredentials: {
    url: process.env.DATABASE_URL ?? '',
  },
});
