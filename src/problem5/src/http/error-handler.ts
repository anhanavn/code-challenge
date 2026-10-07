import type { ErrorRequestHandler, RequestHandler } from 'express';
import { HttpError, badRequest, notFound } from './errors.js';

/** Errors thrown by express.json() carry a `type` we can map to a precise status. */
function fromBodyParser(err: unknown): HttpError | undefined {
  const type = (err as { type?: unknown } | null)?.type;
  if (type === 'entity.too.large') return new HttpError(413, 'Payload Too Large', 'Request body exceeds 100kb');
  if (type === 'entity.parse.failed') return badRequest('Request body is not valid JSON');
  return undefined;
}

export const notFoundHandler: RequestHandler = (req) => {
  throw notFound(`No route for ${req.method} ${req.path}`);
};

/**
 * Renders every error as RFC 9457 problem+json. Unexpected errors are logged
 * with full detail but returned as a generic 500, so stack traces and SQL never
 * reach the client.
 */
export const errorHandler: ErrorRequestHandler = (err, req, res, _next) => {
  const known = err instanceof HttpError ? err : fromBodyParser(err);
  const problem = known ?? new HttpError(500, 'Internal Server Error', 'An unexpected error occurred');
  if (!known) req.log.error({ err }, 'unhandled error');

  res
    .status(problem.status)
    .type('application/problem+json')
    .json({
      type: 'about:blank',
      title: problem.title,
      status: problem.status,
      detail: problem.detail,
      instance: req.originalUrl,
      requestId: req.id,
      ...problem.extensions,
    });
};
