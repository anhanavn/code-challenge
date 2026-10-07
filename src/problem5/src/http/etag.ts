import { badRequest } from './errors.js';

/** The resource version is the ETag: it changes on every successful write. */
export const toETag = (version: number): string => `"${version}"`;

/**
 * Reads the expected version from `If-Match` for optimistic concurrency control.
 * Returns undefined when the client didn't send the header (or sent `*`),
 * meaning "write unconditionally".
 */
export function parseIfMatch(header: string | undefined): number | undefined {
  if (header === undefined || header.trim() === '*') return undefined;
  const match = /^\s*"(\d{1,15})"\s*$/.exec(header);
  if (!match) throw badRequest('If-Match must be a strong ETag such as "3"');
  return Number(match[1]);
}
