import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { decodeCursor, encodeCursor } from '../../http/cursor.js';
import { badRequest, notFound, preconditionFailed } from '../../http/errors.js';
import type { SortField, TaskRepository } from './task.repository.js';
import {
  TASK_PRIORITIES,
  type CreateTaskInput,
  type ListTasksQuery,
  type Task,
  type TaskSort,
  type UpdateTaskInput,
} from './task.schema.js';

export interface TaskPage {
  data: Task[];
  /** Pass back as `cursor` to fetch the next page; null on the last page. */
  nextCursor: string | null;
}

export type Clock = () => Date;

const parseSort = (sort: TaskSort) =>
  sort.startsWith('-')
    ? { field: sort.slice(1) as SortField, direction: 'desc' as const }
    : { field: sort as SortField, direction: 'asc' as const };

const uuid = z.string().uuid();

/** Cursor values are cast in SQL, so they must be valid for their column type or Postgres would raise a 500. */
const CURSOR_VALUE: Record<SortField, z.ZodTypeAny> = {
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  title: z.string().max(200),
  priority: z.enum(TASK_PRIORITIES),
};

export class TaskService {
  constructor(
    private readonly repository: TaskRepository,
    private readonly clock: Clock = () => new Date(),
  ) {}

  create(input: CreateTaskInput): Promise<Task> {
    return this.repository.insert({ id: randomUUID(), ...input, createdAt: this.clock().toISOString() });
  }

  async get(id: string): Promise<Task> {
    const task = uuid.safeParse(id).success ? await this.repository.findById(id) : undefined;
    if (!task) throw notFound(`Task ${id} does not exist`);
    return task;
  }

  async list(query: ListTasksQuery): Promise<TaskPage> {
    const sort = parseSort(query.sort);
    const after = query.cursor ? decodeCursor(query.cursor, query.sort) : undefined;
    if (after && !(uuid.safeParse(after.id).success && CURSOR_VALUE[sort.field].safeParse(after.value).success)) {
      throw badRequest('cursor is malformed');
    }

    // Fetch one extra row to know whether another page exists without a COUNT(*).
    const rows = await this.repository.list({
      statuses: query.status,
      priorities: query.priority,
      search: query.q,
      dueAfter: query.dueAfter,
      dueBefore: query.dueBefore,
      sort,
      after,
      limit: query.limit + 1,
    });

    const hasMore = rows.length > query.limit;
    const data = hasMore ? rows.slice(0, query.limit) : rows;
    const last = data.at(-1);
    return {
      data,
      nextCursor: hasMore && last ? encodeCursor({ sort: query.sort, value: last[sort.field], id: last.id }) : null,
    };
  }

  async update(id: string, patch: UpdateTaskInput, expectedVersion?: number): Promise<Task> {
    const updated = uuid.safeParse(id).success
      ? await this.repository.update(id, patch, this.clock().toISOString(), expectedVersion)
      : undefined;
    if (updated) return updated;
    throw await this.writeRejected(id, expectedVersion);
  }

  async delete(id: string, expectedVersion?: number): Promise<void> {
    const deleted = uuid.safeParse(id).success && (await this.repository.delete(id, expectedVersion));
    if (!deleted) throw await this.writeRejected(id, expectedVersion);
  }

  /** A conditional write matched nothing: tell "gone" apart from "changed under you". */
  private async writeRejected(id: string, expectedVersion?: number) {
    const current = uuid.safeParse(id).success ? await this.repository.findById(id) : undefined;
    if (!current) return notFound(`Task ${id} does not exist`);
    return preconditionFailed(
      `Task ${id} is at version ${current.version}, not ${expectedVersion}. Re-fetch it and retry.`,
    );
  }
}
