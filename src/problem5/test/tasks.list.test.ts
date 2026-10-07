import { beforeEach, describe, expect, it } from 'vitest';
import { encodeCursor } from '../src/http/cursor.js';
import type { Task } from '../src/modules/tasks/task.schema.js';
import { TASKS, createTestApp, frozenClock, type TestContext } from './helpers.js';

let ctx: TestContext;
beforeEach(async () => {
  ctx = await createTestApp();
});

const seed = async (bodies: object[]) => {
  const tasks: Task[] = [];
  for (const body of bodies) tasks.push((await ctx.api.post(TASKS).send(body).expect(201)).body);
  return tasks;
};
const list = (query: Record<string, string | number> = {}) => ctx.api.get(TASKS).query(query);
const titles = (res: { body: { data: Task[] } }) => res.body.data.map((t) => t.title);

describe('GET /tasks filters', () => {
  beforeEach(async () => {
    await seed([
      { title: 'Alpha', status: 'todo', priority: 'high', description: 'Deploy the API', dueDate: '2026-01-10T00:00:00Z' },
      { title: 'Bravo', status: 'in_progress', priority: 'low', dueDate: '2026-01-20T00:00:00Z' },
      { title: 'Charlie', status: 'done', priority: 'high', description: '100% complete' },
      { title: 'Delta', status: 'todo', priority: 'medium', dueDate: '2026-02-01T00:00:00Z' },
    ]);
  });

  it('returns everything, newest first, by default', async () => {
    const res = await list();
    expect(res.status).toBe(200);
    expect(titles(res)).toEqual(['Delta', 'Charlie', 'Bravo', 'Alpha']);
    expect(res.body.nextCursor).toBeNull();
  });

  it('filters by one or several statuses (comma or repeated param)', async () => {
    expect(titles(await list({ status: 'todo' }))).toEqual(['Delta', 'Alpha']);
    expect(titles(await list({ status: 'todo,done', sort: 'title' }))).toEqual(['Alpha', 'Charlie', 'Delta']);
    const repeated = await ctx.api.get(`${TASKS}?status=done&status=in_progress&sort=title`);
    expect(titles(repeated)).toEqual(['Bravo', 'Charlie']);
  });

  it('combines filters with AND', async () => {
    expect(titles(await list({ status: 'todo', priority: 'high' }))).toEqual(['Alpha']);
  });

  it('searches title and description case-insensitively', async () => {
    expect(titles(await list({ q: 'deploy' }))).toEqual(['Alpha']);
    expect(titles(await list({ q: 'CHAR' }))).toEqual(['Charlie']);
  });

  it('treats LIKE wildcards in the search as literals', async () => {
    expect(titles(await list({ q: '%' }))).toEqual(['Charlie']);
    expect(titles(await list({ q: '_' }))).toEqual([]);
  });

  it('filters by due date range (after inclusive, before exclusive)', async () => {
    const res = await list({ dueAfter: '2026-01-10T00:00:00Z', dueBefore: '2026-02-01T00:00:00Z', sort: 'title' });
    expect(titles(res)).toEqual(['Alpha', 'Bravo']);
  });

  it('sorts by title both ways', async () => {
    expect(titles(await list({ sort: 'title' }))).toEqual(['Alpha', 'Bravo', 'Charlie', 'Delta']);
    expect(titles(await list({ sort: '-title' }))).toEqual(['Delta', 'Charlie', 'Bravo', 'Alpha']);
  });

  it('sorts by priority in business order (low < medium < high), not alphabetically', async () => {
    const res = await list({ sort: '-priority' });
    expect(res.body.data.map((t: Task) => t.priority)).toEqual(['high', 'high', 'medium', 'low']);
    expect(titles(await list({ sort: 'priority', limit: 1 }))).toEqual(['Bravo']);
  });

  it.each([
    ['unknown parameter', { stauts: 'done' }],
    ['invalid enum value', { status: 'todo,blocked' }],
    ['limit above max', { limit: 101 }],
    ['limit zero', { limit: 0 }],
    ['unsupported sort', { sort: 'dueDate' }],
    ['invalid date', { dueAfter: 'yesterday' }],
  ])('rejects %s with 400', async (_case, query) => {
    expect((await list(query)).status).toBe(400);
  });
});

describe('GET /tasks pagination', () => {
  /** Walks every page and returns all ids in order. */
  const collect = async (query: Record<string, string | number>) => {
    const ids: string[] = [];
    let cursor: string | null = null;
    do {
      const res = await list(cursor ? { ...query, cursor } : query);
      expect(res.status).toBe(200);
      ids.push(...res.body.data.map((t: Task) => t.id));
      cursor = res.body.nextCursor;
    } while (cursor);
    return ids;
  };

  it('visits every task exactly once, even when timestamps tie', async () => {
    ctx = await createTestApp({ clock: frozenClock() }); // all 25 rows get the same createdAt
    const created = await seed(Array.from({ length: 25 }, (_, i) => ({ title: `Task ${i}` })));

    for (const sort of ['-createdAt', 'createdAt', 'title', '-updatedAt', 'priority']) {
      const ids = await collect({ sort, limit: 7 });
      expect(ids).toHaveLength(25);
      expect(new Set(ids)).toEqual(new Set(created.map((t) => t.id)));
    }
  });

  it('keeps pages stable when rows are inserted ahead of the cursor', async () => {
    await seed(Array.from({ length: 6 }, (_, i) => ({ title: `T${i}` })));
    const first = await list({ sort: 'title', limit: 3 });
    await seed([{ title: 'A-new' }]); // sorts before every existing row

    const second = await list({ sort: 'title', limit: 3, cursor: first.body.nextCursor });
    expect(titles(first)).toEqual(['T0', 'T1', 'T2']);
    expect(titles(second)).toEqual(['T3', 'T4', 'T5']);
  });

  it('rejects a malformed cursor', async () => {
    const res = await list({ cursor: 'not-a-cursor' });
    expect(res.status).toBe(400);
    expect(res.body.detail).toBe('cursor is malformed');
  });

  it('rejects a cursor issued for a different sort', async () => {
    const cursor = encodeCursor({ sort: 'title', value: 'x', id: 'y' });
    const res = await list({ cursor, sort: '-createdAt' });
    expect(res.status).toBe(400);
    expect(res.body.detail).toContain('sort=title');
  });
});
