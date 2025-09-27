
import { migrate } from 'drizzle-orm/pglite/migrator';
import { db } from './db';
import app from '.';

import { initializeDatabase } from './init';

async function main() {
  await migrate(db, { migrationsFolder: './drizzle' });
  await initializeDatabase();

  const server = Bun.serve({
    fetch: app.fetch,
    port: 3000,
  });

  console.log(`Server listening on http://localhost:${server.port}`);
}

main();
