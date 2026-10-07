import 'dotenv/config';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { loadConfig } from '../config.js';
import { MIGRATIONS_FOLDER, createPostgresDatabase } from './client.js';

/**
 * Applies pending migrations, then exits. Runs as its own step (`npm run db:migrate`,
 * or the one-shot `migrate` service in docker-compose) rather than on app startup,
 * so several API replicas never race to migrate the same database.
 */
const config = loadConfig();
const { db, close } = createPostgresDatabase(config.DATABASE_URL, 1);
try {
  await migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });
  console.log('Migrations applied');
} finally {
  await close();
}
