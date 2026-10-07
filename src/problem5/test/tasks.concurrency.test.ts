import { beforeEach, describe, expect, it } from 'vitest';
import { TASKS, createTestApp, type TestContext } from './helpers.js';

let ctx: TestContext;
let url: string;
beforeEach(async () => {
  ctx = await createTestApp();
  const res = await ctx.api.post(TASKS).send({ title: 'Shared task' });
  url = `${TASKS}/${res.body.id}`;
});

describe('optimistic concurrency (If-Match)', () => {
  it('applies the update when If-Match matches the current version', async () => {
    const res = await ctx.api.patch(url).set('If-Match', '"1"').send({ status: 'done' });
    expect(res.status).toBe(200);
    expect(res.headers.etag).toBe('"2"');
  });

  it('prevents a lost update: the second writer with a stale ETag gets 412', async () => {
    const alice = await ctx.api.patch(url).set('If-Match', '"1"').send({ title: 'Alice' });
    const bob = await ctx.api.patch(url).set('If-Match', '"1"').send({ title: 'Bob' });

    expect(alice.status).toBe(200);
    expect(bob.status).toBe(412);
    expect(bob.body.detail).toContain('version 2');
    expect((await ctx.api.get(url)).body.title).toBe('Alice');
  });

  it('refuses to delete a task that changed since it was read', async () => {
    await ctx.api.patch(url).send({ title: 'changed' });
    expect((await ctx.api.delete(url).set('If-Match', '"1"')).status).toBe(412);
    expect((await ctx.api.delete(url).set('If-Match', '"2"')).status).toBe(204);
  });

  it('writes unconditionally without If-Match or with *', async () => {
    expect((await ctx.api.patch(url).send({ title: 'a' })).status).toBe(200);
    expect((await ctx.api.patch(url).set('If-Match', '*').send({ title: 'b' })).status).toBe(200);
  });

  it('returns 404 (not 412) when the task is gone', async () => {
    await ctx.api.delete(url);
    expect((await ctx.api.patch(url).set('If-Match', '"1"').send({ title: 'x' })).status).toBe(404);
  });

  it('rejects a malformed If-Match with 400', async () => {
    for (const header of ['1', 'W/"1"', '"abc"']) {
      expect((await ctx.api.patch(url).set('If-Match', header).send({ title: 'x' })).status).toBe(400);
    }
  });
});
