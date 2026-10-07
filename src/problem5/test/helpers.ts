import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import pino from 'pino';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { loadConfig, type Config } from '../src/config.js';
import { createPostgresDatabase, type Database } from '../src/db/client.js';
import type { Clock } from '../src/modules/tasks/task.service.js';
import { TEMPLATE_DB, TEST_DB_PREFIX, quoteIdent, urlFor, withAdmin } from './support/postgres.js';

export interface TestDatabase {
  db: Database;
  url: string;
  /** Closes the pool (idempotent). */
  close: () => Promise<void>;
  /** Closes the pool and drops the database. */
  drop: () => Promise<void>;
}

/** A brand-new, fully migrated PostgreSQL database cloned from the template built in global setup. */
export async function createTestDatabase(): Promise<TestDatabase> {
  const name = `${TEST_DB_PREFIX}${randomUUID().replaceAll('-', '').slice(0, 12)}`;
  await withAdmin((client) => client.query(`CREATE DATABASE ${quoteIdent(name)} TEMPLATE ${quoteIdent(TEMPLATE_DB)}`));
  const url = urlFor(name);
  const { db, close } = createPostgresDatabase(url, 10);
  return {
    db,
    url,
    close,
    drop: async () => {
      await close();
      await withAdmin((client) => client.query(`DROP DATABASE IF EXISTS ${quoteIdent(name)} WITH (FORCE)`));
    },
  };
}

// One database per test file (files run in parallel), wiped before each test.
let shared: Promise<TestDatabase> | undefined;

export async function releaseSharedDatabase(): Promise<void> {
  if (shared) await (await shared).drop();
  shared = undefined;
}

export interface TestContext {
  api: ReturnType<typeof request>;
  db: Database;
}

export async function createTestApp(
  options: { env?: Partial<Record<keyof Config, string>>; clock?: Clock; db?: Database } = {},
): Promise<TestContext> {
  let db = options.db;
  if (!db) {
    db = (await (shared ??= createTestDatabase())).db;
    await db.execute(sql`TRUNCATE tasks, idempotency_keys`);
  }
  const config = loadConfig({ NODE_ENV: 'test', LOG_LEVEL: 'silent', RATE_LIMIT_MAX: '10000', ...options.env });
  const app = createApp({ config, db, logger: pino({ level: 'silent' }), clock: options.clock });
  return { api: request(app), db };
}

/** A clock frozen at a fixed instant, so many rows share created_at and pagination must break ties by id. */
export const frozenClock =
  (iso = '2026-01-01T00:00:00.000Z'): Clock =>
  () =>
    new Date(iso);

export const TASKS = '/api/v1/tasks';
