import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import express, { type Express } from 'express';
import { rateLimit } from 'express-rate-limit';
import helmet from 'helmet';
import type { Logger } from 'pino';
import { pinoHttp } from 'pino-http';
import swaggerUi from 'swagger-ui-express';
import type { Config } from './config.js';
import type { Database } from './db/client.js';
import { openApiDocument } from './docs/openapi.js';
import { apiKeyAuth } from './http/auth.js';
import { errorHandler, notFoundHandler } from './http/error-handler.js';
import { HttpError } from './http/errors.js';
import { IdempotencyStore } from './http/idempotency.js';
import { TaskRepository } from './modules/tasks/task.repository.js';
import { createTaskRouter } from './modules/tasks/task.routes.js';
import { TaskService, type Clock } from './modules/tasks/task.service.js';

export interface AppDependencies {
  config: Config;
  db: Database;
  logger: Logger;
  clock?: Clock;
}

const REQUEST_ID_PATTERN = /^[\w-]{1,64}$/;

/** Builds the Express app from its dependencies. No I/O happens here, so tests can create one per case. */
export function createApp({ config, db, logger, clock }: AppDependencies): Express {
  const app = express();
  app.set('trust proxy', config.TRUST_PROXY);
  app.set('etag', false); // ETags are version-based and set explicitly per resource

  app.use(
    pinoHttp({
      logger,
      // Reuse an upstream request id (from a gateway/load balancer) when present, for end-to-end tracing.
      genReqId: (req, res) => {
        const incoming = req.headers['x-request-id'];
        const id = typeof incoming === 'string' && REQUEST_ID_PATTERN.test(incoming) ? incoming : randomUUID();
        res.setHeader('X-Request-Id', id);
        return id;
      },
      customLogLevel: (_req, res, err) => (err || res.statusCode >= 500 ? 'error' : res.statusCode >= 400 ? 'warn' : 'info'),
    }),
  );
  // upgrade-insecure-requests breaks the Swagger UI over plain http://localhost in Safari; TLS belongs to the proxy.
  app.use(helmet({ contentSecurityPolicy: { directives: { upgradeInsecureRequests: null } } }));

  // Operational endpoints: unauthenticated and not rate-limited, so probes and docs always work.
  app.get('/health', async (req, res) => {
    try {
      await db.execute(sql`SELECT 1`);
      res.json({ status: 'ok', database: 'up' });
    } catch (err) {
      req.log.error({ err }, 'health check failed');
      res.status(503).json({ status: 'error', database: 'down' });
    }
  });
  app.get('/openapi.json', (_req, res) => {
    res.json(openApiDocument);
  });
  app.use('/docs', swaggerUi.serve, swaggerUi.setup(openApiDocument));

  const api = express.Router();
  api.use(
    rateLimit({
      windowMs: config.RATE_LIMIT_WINDOW_MS,
      limit: config.RATE_LIMIT_MAX,
      standardHeaders: 'draft-8',
      legacyHeaders: false,
      handler: (_req, _res, next) => next(new HttpError(429, 'Too Many Requests', 'Rate limit exceeded, retry later')),
    }),
  );
  api.use(apiKeyAuth(config.API_KEY));
  api.use(express.json({ limit: '100kb' }));

  const taskService = new TaskService(new TaskRepository(db), clock);
  api.use('/tasks', createTaskRouter(taskService, new IdempotencyStore(db, undefined, clock)));
  app.use('/api/v1', api);

  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}
