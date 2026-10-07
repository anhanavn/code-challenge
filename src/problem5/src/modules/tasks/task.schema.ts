import { z } from 'zod';
import { TASK_PRIORITIES, TASK_STATUSES } from '../../db/schema.js';

export { TASK_PRIORITIES, TASK_STATUSES };
export const TASK_SORTS = [
  'createdAt',
  '-createdAt',
  'updatedAt',
  '-updatedAt',
  'title',
  '-title',
  'priority',
  '-priority',
] as const;

export type TaskStatus = (typeof TASK_STATUSES)[number];
export type TaskPriority = (typeof TASK_PRIORITIES)[number];
export type TaskSort = (typeof TASK_SORTS)[number];

export interface Task {
  id: string;
  title: string;
  description: string | null;
  status: TaskStatus;
  priority: TaskPriority;
  dueDate: string | null;
  version: number;
  createdAt: string;
  updatedAt: string;
}

const title = z.string().trim().min(1).max(200);
const description = z.string().trim().max(5000);

/** Accepts any ISO-8601 timestamp with offset; stored normalised to UTC so string comparison == time comparison. */
const isoDateTime = z
  .string()
  .datetime({ offset: true, message: 'Must be an ISO-8601 date-time, e.g. 2026-01-31T17:00:00Z' })
  .transform((value) => new Date(value).toISOString());

export const createTaskSchema = z
  .object({
    title,
    description: description.nullish().transform((v) => v ?? null),
    status: z.enum(TASK_STATUSES).default('todo'),
    priority: z.enum(TASK_PRIORITIES).default('medium'),
    dueDate: isoDateTime.nullish().transform((v) => v ?? null),
  })
  .strict();

/** Partial update: omitted fields are untouched, `null` clears a nullable field. */
export const updateTaskSchema = z
  .object({
    title: title.optional(),
    description: description.nullable().optional(),
    status: z.enum(TASK_STATUSES).optional(),
    priority: z.enum(TASK_PRIORITIES).optional(),
    dueDate: isoDateTime.nullable().optional(),
  })
  .strict()
  .refine((patch) => Object.keys(patch).length > 0, { message: 'Provide at least one field to update' });

/** `status=todo,done` and `status=todo&status=done` are both accepted. */
const enumList = <T extends readonly [string, ...string[]]>(values: T) =>
  z
    .union([z.string(), z.array(z.string())])
    .transform((raw) =>
      [raw]
        .flat()
        .flatMap((s) => s.split(','))
        .map((s) => s.trim())
        .filter(Boolean),
    )
    .pipe(z.array(z.enum(values)).min(1));

export const listTasksQuerySchema = z
  .object({
    status: enumList(TASK_STATUSES).optional(),
    priority: enumList(TASK_PRIORITIES).optional(),
    q: z.string().trim().min(1).max(100).optional(),
    dueAfter: isoDateTime.optional(),
    dueBefore: isoDateTime.optional(),
    sort: z.enum(TASK_SORTS).default('-createdAt'),
    limit: z.coerce.number().int().min(1).max(100).default(20),
    cursor: z.string().max(512).optional(),
  })
  // Unknown params are rejected so a typo like `?stauts=done` fails loudly instead of silently returning everything.
  .strict();

export type CreateTaskInput = z.output<typeof createTaskSchema>;
export type UpdateTaskInput = z.output<typeof updateTaskSchema>;
export type ListTasksQuery = z.output<typeof listTasksQuerySchema>;
