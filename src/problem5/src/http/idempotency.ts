import { createHash } from 'node:crypto';
import { and, eq, isNull, lte, or } from 'drizzle-orm';
import type { RequestHandler } from 'express';
import type { Database } from '../db/client.js';
import { idempotencyKeys } from '../db/schema.js';
import { HttpError, badRequest } from './errors.js';

interface StoredResponse {
  statusCode: number;
  headers: Record<string, string>;
  body: string;
}

type ClaimResult =
  | { state: 'claimed' }
  | { state: 'mismatch' }
  | { state: 'in_progress' }
  | { state: 'completed'; response: StoredResponse };

const DAY_MS = 24 * 60 * 60 * 1000;
/** A claim never completed within this time is assumed abandoned (e.g. the process crashed) and can be taken over. */
const STALE_CLAIM_MS = 60 * 1000;
const KEY_PATTERN = /^[A-Za-z0-9_\-:.]{1,255}$/;
const REPLAYED_HEADERS = ['location', 'etag'];

/**
 * Idempotency records in Postgres. A key is *claimed* atomically before the
 * request is processed (INSERT … ON CONFLICT), so two concurrent requests with
 * the same key, even on different API instances, can never both execute.
 */
export class IdempotencyStore {
  constructor(
    private readonly db: Database,
    private readonly ttlMs = DAY_MS,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  async claim(key: string, requestHash: string): Promise<ClaimResult> {
    const now = this.clock();
    // Inserts a fresh claim, or takes over an expired record or an abandoned claim. Returns nothing otherwise.
    const claimed = await this.db
      .insert(idempotencyKeys)
      .values({ key, requestHash, createdAt: now })
      .onConflictDoUpdate({
        target: idempotencyKeys.key,
        set: { requestHash, statusCode: null, headers: null, responseBody: null, createdAt: now },
        setWhere: or(
          lte(idempotencyKeys.createdAt, this.cutoff()),
          and(isNull(idempotencyKeys.statusCode), lte(idempotencyKeys.createdAt, new Date(now.getTime() - STALE_CLAIM_MS))),
        ),
      })
      .returning({ key: idempotencyKeys.key });
    if (claimed.length > 0) return { state: 'claimed' };

    const [existing] = await this.db.select().from(idempotencyKeys).where(eq(idempotencyKeys.key, key));
    if (!existing) return this.claim(key, requestHash); // released between our two queries: try again
    if (existing.requestHash !== requestHash) return { state: 'mismatch' };
    if (existing.statusCode === null) return { state: 'in_progress' };
    return {
      state: 'completed',
      response: {
        statusCode: existing.statusCode,
        headers: JSON.parse(existing.headers ?? '{}') as Record<string, string>,
        body: existing.responseBody ?? '',
      },
    };
  }

  async complete(key: string, response: StoredResponse): Promise<void> {
    await this.db
      .update(idempotencyKeys)
      .set({ statusCode: response.statusCode, headers: JSON.stringify(response.headers), responseBody: response.body })
      .where(eq(idempotencyKeys.key, key));
    await this.db.delete(idempotencyKeys).where(lte(idempotencyKeys.createdAt, this.cutoff()));
  }

  /** Frees a claim whose request failed, so the client can fix the request and retry with the same key. */
  async release(key: string): Promise<void> {
    await this.db.delete(idempotencyKeys).where(and(eq(idempotencyKeys.key, key), isNull(idempotencyKeys.statusCode)));
  }

  private cutoff(): Date {
    return new Date(this.clock().getTime() - this.ttlMs);
  }
}

/**
 * Makes POST safe to retry: a repeated request with the same `Idempotency-Key`
 * and payload gets the original response instead of creating a duplicate.
 * - same key, different payload       → 422
 * - same key while the first is running → 409 (retry shortly)
 * Only 2xx responses are kept; failures release the key.
 */
export function idempotency(store: IdempotencyStore): RequestHandler {
  return async (req, res, next) => {
    const key = req.get('Idempotency-Key');
    if (key === undefined) return next();
    if (!KEY_PATTERN.test(key)) {
      throw badRequest('Idempotency-Key must be 1-255 characters of [A-Za-z0-9_-:.]');
    }

    const requestHash = createHash('sha256')
      .update(`${req.method} ${req.originalUrl}\n${JSON.stringify(req.body)}`)
      .digest('hex');

    const claim = await store.claim(key, requestHash);
    switch (claim.state) {
      case 'mismatch':
        throw new HttpError(422, 'Idempotency Key Reused', 'This Idempotency-Key was already used with a different request payload');
      case 'in_progress':
        res.set('Retry-After', '1');
        throw new HttpError(409, 'Request In Progress', 'A request with this Idempotency-Key is still being processed');
      case 'completed': {
        const { statusCode, headers, body } = claim.response;
        res.status(statusCode).set(headers).set('Idempotent-Replayed', 'true').type('json').send(body);
        return;
      }
      case 'claimed':
        break;
    }

    // Record the outcome before the response leaves, so an immediate retry sees it.
    const sendJson = res.json.bind(res);
    res.json = (body: unknown) => {
      const succeeded = res.statusCode >= 200 && res.statusCode < 300;
      const headers: Record<string, string> = {};
      for (const name of REPLAYED_HEADERS) {
        const value = res.get(name);
        if (value !== undefined) headers[name] = value;
      }
      const persist = succeeded
        ? store.complete(key, { statusCode: res.statusCode, headers, body: JSON.stringify(body) })
        : store.release(key);
      persist
        .catch((err: unknown) => req.log.error({ err, key }, 'failed to persist idempotency record'))
        .finally(() => sendJson(body));
      return res;
    };
    next();
  };
}
