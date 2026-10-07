import { beforeEach, describe, expect, it } from 'vitest';
import { idempotencyKeys, tasks } from '../src/db/schema.js';
import { TASKS, createTestApp, type TestContext } from './helpers.js';

let ctx: TestContext;
let now: Date;
beforeEach(async () => {
  now = new Date('2026-01-01T00:00:00Z');
  ctx = await createTestApp({ clock: () => now });
});

const count = () => ctx.db.$count(tasks);
const post = (key: string, body: object) => ctx.api.post(TASKS).set('Idempotency-Key', key).send(body);

describe('Idempotency-Key on POST /tasks', () => {
  it('replays the original response for a retried request instead of creating a duplicate', async () => {
    const first = await post('retry-1', { title: 'Pay invoice' });
    const retry = await post('retry-1', { title: 'Pay invoice' });

    expect(first.status).toBe(201);
    expect(retry.status).toBe(201);
    expect(retry.text).toBe(first.text); // byte-for-byte
    expect(retry.headers.location).toBe(first.headers.location);
    expect(retry.headers.etag).toBe(first.headers.etag);
    expect(retry.headers['idempotent-replayed']).toBe('true');
    expect(await count()).toBe(1);
  });

  it('creates exactly one task when identical requests arrive concurrently', async () => {
    const responses = await Promise.all(Array.from({ length: 5 }, () => post('burst', { title: 'Once' })));
    const statuses = responses.map((r) => r.status);

    expect(await count()).toBe(1);
    expect(statuses).toContain(201);
    // Others either replayed the stored 201 or were told the first was still running.
    expect(statuses.every((s) => s === 201 || s === 409)).toBe(true);
  });

  it('rejects reusing a key with a different payload', async () => {
    await post('retry-2', { title: 'A' });
    const res = await post('retry-2', { title: 'B' });
    expect(res.status).toBe(422);
    expect(await count()).toBe(1);
  });

  it('answers 409 with Retry-After while the original request is still running', async () => {
    const first = await post('retry-3', { title: 'A' });
    // Simulate an in-flight claim: same hash, no response recorded yet.
    await ctx.db.update(idempotencyKeys).set({ statusCode: null, responseBody: null });
    const res = await post('retry-3', { title: 'A' });
    expect(first.status).toBe(201);
    expect(res.status).toBe(409);
    expect(res.headers['retry-after']).toBe('1');
  });

  it('lets a new request take over a claim abandoned for over a minute (e.g. after a crash)', async () => {
    await post('retry-4', { title: 'A' });
    await ctx.db.update(idempotencyKeys).set({ statusCode: null, responseBody: null });
    now = new Date(now.getTime() + 61_000);
    expect((await post('retry-4', { title: 'A' })).status).toBe(201);
  });

  it('does not store failed requests, so the client can fix and retry with the same key', async () => {
    expect((await post('retry-5', { title: '' })).status).toBe(400);
    expect((await post('retry-5', { title: 'Fixed' })).status).toBe(201);
  });

  it('forgets keys after 24 hours', async () => {
    await post('retry-6', { title: 'A' });
    now = new Date('2026-01-02T00:00:01Z');
    const res = await post('retry-6', { title: 'A' });
    expect(res.headers['idempotent-replayed']).toBeUndefined();
    expect(await count()).toBe(2);
  });

  it('creates separate tasks when no key is sent', async () => {
    await ctx.api.post(TASKS).send({ title: 'A' });
    await ctx.api.post(TASKS).send({ title: 'A' });
    expect(await count()).toBe(2);
  });

  it('rejects malformed keys', async () => {
    expect((await post('has spaces', { title: 'A' })).status).toBe(400);
    expect((await post('x'.repeat(256), { title: 'A' })).status).toBe(400);
  });
});
