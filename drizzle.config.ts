import type { Config } from 'drizzle-kit';

export default {
  schema: './src/server/db/schema.ts',
  out: './drizzle',
  dialect: 'postgresql',
  driver: 'pglite',
  dbCredentials: {
    url: process.env.POSTGRES_DB || './pipali.db'
  }
} satisfies Config;
