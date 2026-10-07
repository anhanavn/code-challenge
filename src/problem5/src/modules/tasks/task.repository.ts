import { and, asc, desc, eq, gte, ilike, inArray, lt, or, sql, type SQL } from 'drizzle-orm';
import type { Database } from '../../db/client.js';
import { tasks, type TaskRow } from '../../db/schema.js';
import type { Task, TaskPriority, TaskStatus, UpdateTaskInput } from './task.schema.js';

export type SortField = 'createdAt' | 'updatedAt' | 'title' | 'priority';

export interface TaskListFilter {
  statuses?: TaskStatus[];
  priorities?: TaskPriority[];
  search?: string;
  dueAfter?: string;
  dueBefore?: string;
  sort: { field: SortField; direction: 'asc' | 'desc' };
  /** Keyset position: only rows strictly after this (value, id) in sort order. */
  after?: { value: string; id: string };
  limit: number;
}

export interface NewTask {
  id: string;
  title: string;
  description: string | null;
  status: TaskStatus;
  priority: TaskPriority;
  dueDate: string | null;
  createdAt: string;
}

/** Sortable columns and the Postgres type the cursor value must be cast to when compared. */
const SORTS = {
  createdAt: { column: tasks.createdAt, type: sql.raw('timestamptz') },
  updatedAt: { column: tasks.updatedAt, type: sql.raw('timestamptz') },
  title: { column: tasks.title, type: sql.raw('varchar') },
  priority: { column: tasks.priority, type: sql.raw('task_priority') },
} satisfies Record<SortField, unknown>;

const toTask = (row: TaskRow): Task => ({
  id: row.id,
  title: row.title,
  description: row.description,
  status: row.status,
  priority: row.priority,
  dueDate: row.dueDate?.toISOString() ?? null,
  version: row.version,
  createdAt: row.createdAt.toISOString(),
  updatedAt: row.updatedAt.toISOString(),
});

const toDate = (iso: string | null | undefined) => (iso == null ? iso : new Date(iso));

/** Escapes LIKE wildcards so a search for "50%" matches literally (backslash is Postgres' default escape). */
const escapeLike = (s: string) => s.replace(/[\\%_]/g, (c) => `\\${c}`);

export class TaskRepository {
  constructor(private readonly db: Database) {}

  async insert(task: NewTask): Promise<Task> {
    const createdAt = new Date(task.createdAt);
    const [row] = await this.db
      .insert(tasks)
      .values({ ...task, dueDate: toDate(task.dueDate), createdAt, updatedAt: createdAt })
      .returning();
    return toTask(row!);
  }

  async findById(id: string): Promise<Task | undefined> {
    const [row] = await this.db.select().from(tasks).where(eq(tasks.id, id)).limit(1);
    return row && toTask(row);
  }

  /**
   * Applies the patch and bumps the version in one statement. When
   * `expectedVersion` is given the write only happens if the row is still at
   * that version, so a concurrent writer is never silently overwritten.
   * Returns undefined if no row matched (missing, or version moved on).
   */
  async update(id: string, patch: UpdateTaskInput, updatedAt: string, expectedVersion?: number): Promise<Task | undefined> {
    const { dueDate, ...rest } = patch;
    const [row] = await this.db
      .update(tasks)
      .set({
        ...rest,
        ...(dueDate !== undefined && { dueDate: toDate(dueDate) }),
        version: sql`${tasks.version} + 1`,
        updatedAt: new Date(updatedAt),
      })
      .where(and(eq(tasks.id, id), expectedVersion === undefined ? undefined : eq(tasks.version, expectedVersion)))
      .returning();
    return row && toTask(row);
  }

  /** Returns false if no row matched (missing, or version moved on). */
  async delete(id: string, expectedVersion?: number): Promise<boolean> {
    const deleted = await this.db
      .delete(tasks)
      .where(and(eq(tasks.id, id), expectedVersion === undefined ? undefined : eq(tasks.version, expectedVersion)))
      .returning({ id: tasks.id });
    return deleted.length > 0;
  }

  async list(filter: TaskListFilter): Promise<Task[]> {
    const { column, type } = SORTS[filter.sort.field];
    const ascending = filter.sort.direction === 'asc';
    const pattern = filter.search && `%${escapeLike(filter.search)}%`;

    const conditions: (SQL | undefined)[] = [
      filter.statuses?.length ? inArray(tasks.status, filter.statuses) : undefined,
      filter.priorities?.length ? inArray(tasks.priority, filter.priorities) : undefined,
      // Full scan for now; a pg_trgm GIN index makes this fast at scale (see README).
      pattern ? or(ilike(tasks.title, pattern), ilike(tasks.description, pattern)) : undefined,
      filter.dueAfter ? gte(tasks.dueDate, new Date(filter.dueAfter)) : undefined,
      filter.dueBefore ? lt(tasks.dueDate, new Date(filter.dueBefore)) : undefined,
      // Row-value comparison seeks straight to the position via the (column, id) index: O(log n) per page.
      filter.after
        ? sql`(${column}, ${tasks.id}) ${sql.raw(ascending ? '>' : '<')} (${filter.after.value}::${type}, ${filter.after.id}::uuid)`
        : undefined,
    ];

    const rows = await this.db
      .select()
      .from(tasks)
      .where(and(...conditions))
      .orderBy(...(ascending ? [asc(column), asc(tasks.id)] : [desc(column), desc(tasks.id)]))
      .limit(filter.limit);
    return rows.map(toTask);
  }
}
