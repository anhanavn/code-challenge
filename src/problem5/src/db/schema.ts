import { sql } from 'drizzle-orm';
import { check, index, integer, pgEnum, pgTable, text, timestamp, uuid, varchar } from 'drizzle-orm/pg-core';

export const TASK_STATUSES = ['todo', 'in_progress', 'done'] as const;
/** Declared in ascending order: Postgres sorts enum values by declaration order, so `ORDER BY priority` works. */
export const TASK_PRIORITIES = ['low', 'medium', 'high'] as const;

export const taskStatus = pgEnum('task_status', TASK_STATUSES);
export const taskPriority = pgEnum('task_priority', TASK_PRIORITIES);

/**
 * Millisecond precision on purpose: JS Dates hold milliseconds, Postgres
 * defaults to microseconds. With the default, a cursor built from a JS Date
 * would sit *before* its own row, and that row would show up on the next page again.
 */
const timestampMs = (name: string) => timestamp(name, { withTimezone: true, precision: 3, mode: 'date' });

export const tasks = pgTable(
  'tasks',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    title: varchar('title', { length: 200 }).notNull(),
    description: text('description'),
    status: taskStatus('status').notNull().default('todo'),
    priority: taskPriority('priority').notNull().default('medium'),
    dueDate: timestampMs('due_date'),
    version: integer('version').notNull().default(1),
    createdAt: timestampMs('created_at').notNull().defaultNow(),
    updatedAt: timestampMs('updated_at').notNull().defaultNow(),
  },
  (t) => [
    // Keyset pagination: one composite index per sortable column, with id as tie-breaker.
    index('tasks_created_at_id_idx').on(t.createdAt, t.id),
    index('tasks_updated_at_id_idx').on(t.updatedAt, t.id),
    index('tasks_title_id_idx').on(t.title, t.id),
    index('tasks_priority_id_idx').on(t.priority, t.id),
    index('tasks_status_created_at_idx').on(t.status, t.createdAt),
    index('tasks_due_date_idx').on(t.dueDate),
    check('tasks_title_not_blank', sql`char_length(btrim(${t.title})) > 0`),
    check('tasks_description_length', sql`char_length(${t.description}) <= 5000`),
    check('tasks_version_positive', sql`${t.version} > 0`),
  ],
);

/**
 * Idempotency records. `status_code IS NULL` means a request holding this key
 * is still being processed; the body is stored as text to replay it byte-for-byte.
 */
export const idempotencyKeys = pgTable(
  'idempotency_keys',
  {
    key: varchar('key', { length: 255 }).primaryKey(),
    requestHash: varchar('request_hash', { length: 64 }).notNull(),
    statusCode: integer('status_code'),
    headers: text('headers'),
    responseBody: text('response_body'),
    createdAt: timestampMs('created_at').notNull(),
  },
  (t) => [index('idempotency_keys_created_at_idx').on(t.createdAt)],
);

export type TaskRow = typeof tasks.$inferSelect;
export type NewTaskRow = typeof tasks.$inferInsert;
