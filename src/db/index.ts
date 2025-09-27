
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { getDbName } from '../utils';

const dbName = getDbName();
const client = new PGlite(dbName);
export const db = drizzle(client);
