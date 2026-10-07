import { sql } from 'drizzle-orm';
import { beforeAll, describe, expect, it } from 'vitest';
import { TASKS, createTestApp, createTestDatabase, type TestContext } from './helpers.js';

const API_KEY = 'test-key-0123456789abcdef';

describe('API key authentication', () => {
  let api: TestContext['api'];
  beforeAll(async () => {
    ({ api } = await createTestApp({ env: { API_KEY } }));
  });

  it('rejects requests without a key', async () => {
    const res = await api.get(TASKS);
    expect(res.status).toBe(401);
    expect(res.headers['www-authenticate']).toBe('Bearer');
  });

  it('rejects a wrong key', async () => {
    expect((await api.get(TASKS).set('Authorization', 'Bearer wrong')).status).toBe(401);
    expect((await api.get(TASKS).set('Authorization', API_KEY)).status).toBe(401); // missing scheme
  });

  it('accepts the configured key', async () => {
    expect((await api.get(TASKS).auth(API_KEY, { type: 'bearer' })).status).toBe(200);
  });

  it('rejects before parsing the body', async () => {
    const res = await api.post(TASKS).set('Content-Type', 'application/json').send('{bad json');
    expect(res.status).toBe(401);
  });

  it('keeps /health and /openapi.json public', async () => {
    expect((await api.get('/health')).body).toEqual({ status: 'ok', database: 'up' });
    expect((await api.get('/openapi.json')).body.openapi).toBe('3.1.0');
  });
});

describe('hardening', () => {
  it('sets security headers and hides the framework', async () => {
    const { api } = await createTestApp();
    const res = await api.get('/health');
    expect(res.headers['x-powered-by']).toBeUndefined();
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['content-security-policy']).toBeDefined();
  });

  it('rejects bodies over 100kb with 413', async () => {
    const { api } = await createTestApp();
    const res = await api.post(TASKS).send({ title: 'x', description: 'a'.repeat(110_000) });
    expect(res.status).toBe(413);
  });

  it('rate-limits the API with 429 and standard headers', async () => {
    const { api } = await createTestApp({ env: { RATE_LIMIT_MAX: '2' } });
    expect((await api.get(TASKS)).status).toBe(200);
    expect((await api.get(TASKS)).status).toBe(200);
    const limited = await api.get(TASKS);
    expect(limited.status).toBe(429);
    expect(limited.headers['ratelimit-policy']).toBeDefined();
  });

  it('treats SQL in user input as data', async () => {
    const { api, db } = await createTestApp();
    const payload = "x'); DROP TABLE tasks; --";
    await api.post(TASKS).send({ title: payload }).expect(201);
    const res = await api.get(TASKS).query({ q: payload });
    expect(res.body.data).toHaveLength(1);
    const { rows } = await db.execute<{ t: string }>(sql`SELECT to_regclass('tasks')::text AS t`);
    expect(rows).toEqual([{ t: 'tasks' }]);
  });

  it('never lets a malformed id or cursor reach Postgres as a cast error', async () => {
    const { api } = await createTestApp();
    expect((await api.get(`${TASKS}/'; SELECT 1 --`)).status).toBe(404);
    expect((await api.delete(`${TASKS}/123`)).status).toBe(404);
    const forged = Buffer.from(JSON.stringify({ sort: '-createdAt', value: 'not-a-date', id: 'x' })).toString('base64url');
    expect((await api.get(TASKS).query({ cursor: forged })).status).toBe(400);
  });

  it('propagates a safe incoming X-Request-Id and ignores unsafe ones', async () => {
    const { api } = await createTestApp();
    expect((await api.get('/health').set('X-Request-Id', 'trace-abc-123')).headers['x-request-id']).toBe('trace-abc-123');
    const unsafe = await api.get('/health').set('X-Request-Id', '<script>');
    expect(unsafe.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('returns problem+json 404 for unknown routes', async () => {
    const { api } = await createTestApp();
    const res = await api.get('/nope');
    expect(res.status).toBe(404);
    expect(res.headers['content-type']).toContain('application/problem+json');
  });

  it('hides internal error details behind a generic 500', async () => {
    const isolated = await createTestDatabase(); // separate DB: we break it on purpose
    const { api } = await createTestApp({ db: isolated.db });
    await isolated.db.execute(sql`DROP TABLE tasks`);
    const res = await api.get(TASKS);
    expect(res.status).toBe(500);
    expect(res.body.detail).toBe('An unexpected error occurred');
    expect(JSON.stringify(res.body)).not.toContain('does not exist');
    await isolated.drop();
  });

  it('reports 503 from /health when the database is unreachable', async () => {
    const isolated = await createTestDatabase();
    const { api } = await createTestApp({ db: isolated.db });
    await isolated.close(); // pool gone: every query now fails
    const res = await api.get('/health');
    await isolated.drop();
    expect(res.status).toBe(503);
    expect(res.body).toEqual({ status: 'error', database: 'down' });
  });
});
