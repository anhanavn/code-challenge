import { Router, type RequestHandler } from 'express';
import { unsupportedMediaType } from '../../http/errors.js';
import { parseIfMatch, toETag } from '../../http/etag.js';
import { idempotency, type IdempotencyStore } from '../../http/idempotency.js';
import { parse } from '../../http/validation.js';
import { createTaskSchema, listTasksQuerySchema, updateTaskSchema } from './task.schema.js';
import type { TaskService } from './task.service.js';

const requireJson: RequestHandler = (req, _res, next) => {
  if (!req.is('application/json')) throw unsupportedMediaType();
  next();
};

/** Express 5 forwards rejected promises from async handlers to the error handler. */
export function createTaskRouter(service: TaskService, idempotencyStore: IdempotencyStore): Router {
  const router = Router();

  router.post('/', requireJson, idempotency(idempotencyStore), async (req, res) => {
    const task = await service.create(parse(createTaskSchema, req.body));
    res.status(201).location(`${req.baseUrl}/${task.id}`).set('ETag', toETag(task.version)).json(task);
  });

  router.get('/', async (req, res) => {
    res.json(await service.list(parse(listTasksQuerySchema, req.query)));
  });

  router.get('/:id', async (req, res) => {
    const task = await service.get(req.params.id);
    res.set('ETag', toETag(task.version)).json(task);
  });

  router.patch<{ id: string }>('/:id', requireJson, async (req, res) => {
    const patch = parse(updateTaskSchema, req.body);
    const task = await service.update(req.params.id, patch, parseIfMatch(req.get('If-Match')));
    res.set('ETag', toETag(task.version)).json(task);
  });

  router.delete('/:id', async (req, res) => {
    await service.delete(req.params.id, parseIfMatch(req.get('If-Match')));
    res.status(204).end();
  });

  return router;
}
