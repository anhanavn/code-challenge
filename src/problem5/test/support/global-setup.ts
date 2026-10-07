import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { MIGRATIONS_FOLDER, createPostgresDatabase } from '../../src/db/client.js';
import { ADMIN_URL, TEMPLATE_DB, dropTestDatabases, quoteIdent, urlFor, withAdmin } from './postgres.js';

/** Runs once before all test files: builds the migrated template database. Returns the teardown. */
export default async function setup(): Promise<() => Promise<void>> {
  try {
    await withAdmin((client) => client.query('SELECT 1'));
  } catch (error) {
    const target = new URL(ADMIN_URL);
    target.password = '***';
    throw new Error(
      `Cannot reach PostgreSQL at ${target}.\n` +
        'Start it with `npm run db:up` (docker compose), or point TEST_DATABASE_URL at a server where the user can CREATE DATABASE.\n' +
        `Cause: ${(error as NodeJS.ErrnoException).code ?? ''} ${(error as Error).message}`.trim(),
    );
  }

  await dropTestDatabases(); // leftovers from an interrupted run
  await withAdmin((client) => client.query(`CREATE DATABASE ${quoteIdent(TEMPLATE_DB)}`));

  const template = createPostgresDatabase(urlFor(TEMPLATE_DB), 1);
  try {
    await migrate(template.db, { migrationsFolder: MIGRATIONS_FOLDER });
  } finally {
    await template.close(); // a template must have no open connections to be cloned
  }

  return dropTestDatabases;
}
