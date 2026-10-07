import type { z } from 'zod';
import { validationFailed } from './errors.js';

/** Parses untrusted input, throwing a 400 with per-field messages on failure. */
export function parse<S extends z.ZodTypeAny>(schema: S, data: unknown): z.output<S> {
  const result = schema.safeParse(data);
  if (!result.success) {
    throw validationFailed(
      result.error.issues.map((issue) => ({
        field: issue.path.join('.') || '(root)',
        message: issue.message,
      })),
    );
  }
  return result.data;
}
