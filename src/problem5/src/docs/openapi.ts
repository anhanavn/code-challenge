import { TASK_PRIORITIES, TASK_SORTS, TASK_STATUSES } from '../modules/tasks/task.schema.js';

const problem = (description: string) => ({
  description,
  content: { 'application/problem+json': { schema: { $ref: '#/components/schemas/Problem' } } },
});

const taskResponse = (description: string) => ({
  description,
  headers: { ETag: { $ref: '#/components/headers/ETag' } },
  content: { 'application/json': { schema: { $ref: '#/components/schemas/Task' } } },
});

const idParam = { name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } };
const ifMatchParam = {
  name: 'If-Match',
  in: 'header',
  required: false,
  description: 'Optimistic concurrency: the ETag from your last read. The write fails with 412 if the task changed since.',
  schema: { type: 'string', example: '"3"' },
};

export const openApiDocument = {
  openapi: '3.1.0',
  info: {
    title: 'Tasks API',
    version: '1.0.0',
    description: 'CRUD service for tasks. Errors use RFC 9457 problem+json.',
  },
  servers: [{ url: '/api/v1' }],
  security: [{ bearerAuth: [] }],
  paths: {
    '/tasks': {
      post: {
        summary: 'Create a task',
        parameters: [
          {
            name: 'Idempotency-Key',
            in: 'header',
            required: false,
            description: 'Retrying with the same key and payload returns the original response instead of a duplicate (24h).',
            schema: { type: 'string', maxLength: 255 },
          },
        ],
        requestBody: {
          required: true,
          content: { 'application/json': { schema: { $ref: '#/components/schemas/CreateTask' } } },
        },
        responses: {
          201: taskResponse('Created'),
          400: problem('Validation failed'),
          401: problem('Missing or invalid API key'),
          409: problem('A request with the same Idempotency-Key is still in progress'),
          415: problem('Content-Type is not application/json'),
          422: problem('Idempotency-Key reused with a different payload'),
          429: problem('Rate limit exceeded'),
        },
      },
      get: {
        summary: 'List tasks',
        description: 'Filters combine with AND. Results are paginated with an opaque cursor.',
        parameters: [
          {
            name: 'status',
            in: 'query',
            description: 'Comma-separated list',
            schema: { type: 'string', example: 'todo,in_progress' },
          },
          { name: 'priority', in: 'query', description: 'Comma-separated list', schema: { type: 'string', example: 'high' } },
          {
            name: 'q',
            in: 'query',
            description: 'Case-insensitive substring match on title and description',
            schema: { type: 'string', maxLength: 100 },
          },
          { name: 'dueAfter', in: 'query', description: 'dueDate >= value (inclusive)', schema: { type: 'string', format: 'date-time' } },
          { name: 'dueBefore', in: 'query', description: 'dueDate < value (exclusive)', schema: { type: 'string', format: 'date-time' } },
          { name: 'sort', in: 'query', schema: { type: 'string', enum: TASK_SORTS, default: '-createdAt' } },
          { name: 'limit', in: 'query', schema: { type: 'integer', minimum: 1, maximum: 100, default: 20 } },
          { name: 'cursor', in: 'query', description: '`nextCursor` from the previous page', schema: { type: 'string' } },
        ],
        responses: {
          200: {
            description: 'A page of tasks',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/TaskPage' } } },
          },
          400: problem('Invalid filter, unknown parameter or bad cursor'),
          401: problem('Missing or invalid API key'),
        },
      },
    },
    '/tasks/{id}': {
      parameters: [idParam],
      get: {
        summary: 'Get a task',
        responses: { 200: taskResponse('The task'), 404: problem('Not found') },
      },
      patch: {
        summary: 'Update a task (partial)',
        description: 'Omitted fields are unchanged; `null` clears description or dueDate.',
        parameters: [ifMatchParam],
        requestBody: {
          required: true,
          content: { 'application/json': { schema: { $ref: '#/components/schemas/UpdateTask' } } },
        },
        responses: {
          200: taskResponse('Updated'),
          400: problem('Validation failed'),
          404: problem('Not found'),
          412: problem('The task changed since the version in If-Match'),
        },
      },
      delete: {
        summary: 'Delete a task',
        parameters: [ifMatchParam],
        responses: {
          204: { description: 'Deleted' },
          404: problem('Not found'),
          412: problem('The task changed since the version in If-Match'),
        },
      },
    },
  },
  components: {
    securitySchemes: {
      bearerAuth: { type: 'http', scheme: 'bearer', description: 'Only enforced when the server has API_KEY set' },
    },
    headers: {
      ETag: { description: 'Current version of the task, for use in If-Match', schema: { type: 'string', example: '"1"' } },
    },
    schemas: {
      Task: {
        type: 'object',
        required: ['id', 'title', 'description', 'status', 'priority', 'dueDate', 'version', 'createdAt', 'updatedAt'],
        properties: {
          id: { type: 'string', format: 'uuid' },
          title: { type: 'string', minLength: 1, maxLength: 200 },
          description: { type: ['string', 'null'], maxLength: 5000 },
          status: { type: 'string', enum: TASK_STATUSES },
          priority: { type: 'string', enum: TASK_PRIORITIES },
          dueDate: { type: ['string', 'null'], format: 'date-time' },
          version: { type: 'integer', minimum: 1 },
          createdAt: { type: 'string', format: 'date-time' },
          updatedAt: { type: 'string', format: 'date-time' },
        },
      },
      CreateTask: {
        type: 'object',
        additionalProperties: false,
        required: ['title'],
        properties: {
          title: { type: 'string', minLength: 1, maxLength: 200 },
          description: { type: ['string', 'null'], maxLength: 5000 },
          status: { type: 'string', enum: TASK_STATUSES, default: 'todo' },
          priority: { type: 'string', enum: TASK_PRIORITIES, default: 'medium' },
          dueDate: { type: ['string', 'null'], format: 'date-time' },
        },
      },
      UpdateTask: {
        type: 'object',
        additionalProperties: false,
        minProperties: 1,
        properties: {
          title: { type: 'string', minLength: 1, maxLength: 200 },
          description: { type: ['string', 'null'], maxLength: 5000 },
          status: { type: 'string', enum: TASK_STATUSES },
          priority: { type: 'string', enum: TASK_PRIORITIES },
          dueDate: { type: ['string', 'null'], format: 'date-time' },
        },
      },
      TaskPage: {
        type: 'object',
        required: ['data', 'nextCursor'],
        properties: {
          data: { type: 'array', items: { $ref: '#/components/schemas/Task' } },
          nextCursor: { type: ['string', 'null'] },
        },
      },
      Problem: {
        type: 'object',
        properties: {
          type: { type: 'string' },
          title: { type: 'string' },
          status: { type: 'integer' },
          detail: { type: 'string' },
          instance: { type: 'string' },
          requestId: { type: 'string' },
          errors: {
            type: 'array',
            items: { type: 'object', properties: { field: { type: 'string' }, message: { type: 'string' } } },
          },
        },
      },
    },
  },
};
