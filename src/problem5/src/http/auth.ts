import { createHash, timingSafeEqual } from 'node:crypto';
import type { RequestHandler } from 'express';
import { unauthorized } from './errors.js';

const sha256 = (value: string) => createHash('sha256').update(value).digest();

/**
 * Bearer API-key authentication. Disabled when no key is configured, so the
 * service runs with zero setup locally. Both sides are hashed first so
 * timingSafeEqual compares equal-length buffers and the key's length doesn't
 * leak through timing.
 */
export function apiKeyAuth(apiKey: string | undefined): RequestHandler {
  if (!apiKey) return (_req, _res, next) => next();

  const expected = sha256(apiKey);
  return (req, res, next) => {
    const provided = /^Bearer (.+)$/.exec(req.get('Authorization') ?? '')?.[1];
    if (!provided || !timingSafeEqual(sha256(provided), expected)) {
      res.set('WWW-Authenticate', 'Bearer');
      throw unauthorized();
    }
    next();
  };
}
