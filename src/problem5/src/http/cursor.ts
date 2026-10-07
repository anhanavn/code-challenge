import { z } from 'zod';
import { badRequest } from './errors.js';

/**
 * Opaque keyset-pagination cursor: the sort key and value of the last row on
 * the previous page plus its id as tie-breaker. Values are always bound as SQL
 * parameters, so a tampered cursor can at worst return a different page.
 */
export interface Cursor {
  sort: string;
  value: string;
  id: string;
}

const cursorSchema = z.object({ sort: z.string(), value: z.string(), id: z.string() }).strict();

export function encodeCursor(cursor: Cursor): string {
  return Buffer.from(JSON.stringify(cursor)).toString('base64url');
}

export function decodeCursor(raw: string, expectedSort: string): Cursor {
  let cursor: Cursor;
  try {
    cursor = cursorSchema.parse(JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')));
  } catch {
    throw badRequest('cursor is malformed');
  }
  if (cursor.sort !== expectedSort) {
    throw badRequest(`cursor was issued for sort=${cursor.sort}; repeat the request with the same sort`);
  }
  return cursor;
}
