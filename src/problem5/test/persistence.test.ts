import { sql } from 'drizzle-orm';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
import { MIGRATIONS_FOLDER, createPostgresDatabase } from '../src/db/client.js';
import { TASKS, createTestApp, createTestDatabase } from './helpers.js';

describe('persistence', () => {
  it('keeps data across restarts (new connection pool)', async () => {
    const database = await createTestDatabase();
    const created = await (await createTestApp({ db: database.db })).api.post(TASKS).send({ title: 'Survives restart' });
    await database.close();

    const restarted = createPostgresDatabase(database.url, 2);
    const res = await (await createTestApp({ db: restarted.db })).api.get(`${TASKS}/${created.body.id}`);
    await restarted.close();
    await database.drop();

    expect(res.status).toBe(200);
    expect(res.body.title).toBe('Survives restart');
  });

  it('re-running migrations is a no-op', async () => {
    const { db, drop } = await createTestDatabase();
    await migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });
    const { rows } = await db.execute<{ n: number }>(sql`SELECT count(*)::int AS n FROM drizzle.__drizzle_migrations`);
    await drop();
    expect(rows).toEqual([{ n: 1 }]);
  });

  it('enforces constraints in the database too, not only in the API layer', async () => {
    const { db, drop } = await createTestDatabase();
    const insert = (title: string, status: string) =>
      db.execute(sql`INSERT INTO tasks (title, status) VALUES (${title}, ${status}::task_status)`);

    await expect(insert('ok', 'todo')).resolves.toBeDefined();
    // Drizzle wraps the driver error; the Postgres SQLSTATE is on `cause`.
    await expect(insert('ok', 'bogus')).rejects.toMatchObject({ cause: { code: '22P02' } }); // invalid enum value
    await expect(insert('   ', 'todo')).rejects.toMatchObject({
      cause: { code: '23514', constraint: 'tasks_title_not_blank' }, // check_violation
    });
    await drop();
  });
});

describe('config', () => {
  it('applies defaults', () => {
    const config = loadConfig({});
    expect(config).toMatchObject({
      PORT: 3000,
      DATABASE_URL: 'postgres://tasks:tasks@localhost:5432/tasks',
      DB_POOL_MAX: 10,
      RATE_LIMIT_MAX: 100,
    });
    expect(config.API_KEY).toBeUndefined();
  });

  it('treats an empty API_KEY as unset', () => {
    expect(loadConfig({ API_KEY: '' }).API_KEY).toBeUndefined();
  });

  it('fails fast on invalid values', () => {
    expect(() => loadConfig({ PORT: 'eighty' })).toThrow(/PORT/);
    expect(() => loadConfig({ API_KEY: 'short' })).toThrow(/API_KEY/);
    expect(() => loadConfig({ DATABASE_URL: 'not a url' })).toThrow(/DATABASE_URL/);
  });
});
