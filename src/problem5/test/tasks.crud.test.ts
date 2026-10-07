import { beforeEach, describe, expect, it } from 'vitest';
import { TASKS, createTestApp, type TestContext } from './helpers.js';

let ctx: TestContext;
beforeEach(async () => {
  ctx = await createTestApp();
});

const create = (body: object) => ctx.api.post(TASKS).send(body);

describe('POST /tasks', () => {
  it('creates a task with defaults and returns Location + ETag', async () => {
    const res = await create({ title: '  Write tests  ' });

    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      title: 'Write tests', // trimmed
      description: null,
      status: 'todo',
      priority: 'medium',
      dueDate: null,
      version: 1,
    });
    expect(res.body.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(res.body.createdAt).toBe(res.body.updatedAt);
    expect(res.headers.location).toBe(`${TASKS}/${res.body.id}`);
    expect(res.headers.etag).toBe('"1"');
  });

  it('normalises dueDate to UTC', async () => {
    const res = await create({ title: 'x', dueDate: '2026-03-01T09:00:00+07:00' });
    expect(res.body.dueDate).toBe('2026-03-01T02:00:00.000Z');
  });

  it.each([
    ['missing title', {}, 'title'],
    ['empty title', { title: '   ' }, 'title'],
    ['title too long', { title: 'a'.repeat(201) }, 'title'],
    ['invalid status', { title: 'x', status: 'blocked' }, 'status'],
    ['invalid date', { title: 'x', dueDate: 'tomorrow' }, 'dueDate'],
    ['unknown field', { title: 'x', id: 'chosen-by-client' }, '(root)'],
  ])('rejects %s with 400 and a field error', async (_case, body, field) => {
    const res = await create(body);
    expect(res.status).toBe(400);
    expect(res.headers['content-type']).toContain('application/problem+json');
    expect(res.body.title).toBe('Validation Failed');
    expect(res.body.errors).toEqual(expect.arrayContaining([expect.objectContaining({ field })]));
  });

  it('rejects malformed JSON with 400', async () => {
    const res = await ctx.api.post(TASKS).set('Content-Type', 'application/json').send('{"title":');
    expect(res.status).toBe(400);
    expect(res.body.detail).toBe('Request body is not valid JSON');
  });

  it('rejects non-JSON bodies with 415', async () => {
    const res = await ctx.api.post(TASKS).type('form').send('title=x');
    expect(res.status).toBe(415);
  });
});

describe('GET /tasks/:id', () => {
  it('returns the task with its ETag', async () => {
    const { body: created } = await create({ title: 'Read me' });
    const res = await ctx.api.get(`${TASKS}/${created.id}`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual(created);
    expect(res.headers.etag).toBe('"1"');
  });

  it('returns 404 problem+json for an unknown id', async () => {
    const res = await ctx.api.get(`${TASKS}/does-not-exist`);
    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({ status: 404, title: 'Not Found', instance: `${TASKS}/does-not-exist` });
    expect(res.body.requestId).toBeTruthy();
  });
});

describe('PATCH /tasks/:id', () => {
  it('updates only the given fields and bumps version + updatedAt', async () => {
    const { body: created } = await create({ title: 'Old', description: 'keep me', priority: 'low' });
    await new Promise((r) => setTimeout(r, 5));

    const res = await ctx.api.patch(`${TASKS}/${created.id}`).send({ title: 'New', status: 'in_progress' });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      title: 'New',
      status: 'in_progress',
      description: 'keep me',
      priority: 'low',
      version: 2,
      createdAt: created.createdAt,
    });
    expect(res.body.updatedAt > created.updatedAt).toBe(true);
    expect(res.headers.etag).toBe('"2"');
  });

  it('clears nullable fields with null', async () => {
    const { body: created } = await create({ title: 'x', description: 'd', dueDate: '2026-05-01T00:00:00Z' });
    const res = await ctx.api.patch(`${TASKS}/${created.id}`).send({ description: null, dueDate: null });
    expect(res.body).toMatchObject({ description: null, dueDate: null });
  });

  it('rejects an empty patch', async () => {
    const { body: created } = await create({ title: 'x' });
    const res = await ctx.api.patch(`${TASKS}/${created.id}`).send({});
    expect(res.status).toBe(400);
  });

  it('rejects null for a required field', async () => {
    const { body: created } = await create({ title: 'x' });
    const res = await ctx.api.patch(`${TASKS}/${created.id}`).send({ title: null });
    expect(res.status).toBe(400);
  });

  it('returns 404 for an unknown id', async () => {
    const res = await ctx.api.patch(`${TASKS}/nope`).send({ title: 'x' });
    expect(res.status).toBe(404);
  });
});

describe('DELETE /tasks/:id', () => {
  it('deletes the task, then 404s', async () => {
    const { body: created } = await create({ title: 'x' });

    const del = await ctx.api.delete(`${TASKS}/${created.id}`);
    expect(del.status).toBe(204);
    expect(del.text).toBe('');

    expect((await ctx.api.get(`${TASKS}/${created.id}`)).status).toBe(404);
    expect((await ctx.api.delete(`${TASKS}/${created.id}`)).status).toBe(404);
  });
});
