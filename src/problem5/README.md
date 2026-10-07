# Problem 5: A Crude Server (Tasks API)

A CRUD API for **tasks**, built with Express 5, TypeScript, Drizzle ORM and PostgreSQL.

The service is small, but it covers what a production API needs: input validation, safe concurrent updates, safe retries (also across API instances), pagination that doesn't skip or repeat rows, consistent errors, authentication, rate limiting, structured logs and graceful shutdown. It also has 71 integration tests against real PostgreSQL and a CI/CD pipeline.

## Quick start

### Option A: everything in Docker

The only requirement is Docker.

```bash
docker compose up --build
```

This starts three services in order:

1. **postgres**: PostgreSQL 17, waiting until it reports healthy
2. **migrate**: applies the SQL migrations once, then exits
3. **api**: starts only if the migration succeeded, on **http://localhost:3000**

Interactive API docs: **http://localhost:3000/docs**

```bash
API_KEY=change-me-to-16-chars docker compose up --build   # with authentication on
docker compose down        # stop (data stays in the "pgdata" volume)
docker compose down -v     # stop and delete the data
```

### Option B: API on your machine, Postgres in Docker

Requires Node 20 or later. This gives live reload while you develop.

```bash
npm install
cp .env.example .env
npm run db:up          # start only the postgres service
npm run db:migrate     # apply migrations
npm run db:seed        # optional: insert 6 sample tasks
npm run dev            # http://localhost:3000, restarts on file changes
```

### Tests

The tests run against **real PostgreSQL**, the same engine and driver as production. There are no mocks.

```bash
npm run db:up          # PostgreSQL in Docker (skip if it's already running)
npm test               # 71 tests in about 2 seconds
npm run typecheck      # tsc --strict over source and tests
npm run test:smoke     # end-to-end check against a running stack (after docker compose up)
```

How the tests stay isolated and fast:

- At the start, global setup creates a template database and applies the migrations to it once.
- Each test file gets its own copy (`CREATE DATABASE … TEMPLATE`, about 100 ms), so files run in parallel without sharing data.
- Tables are emptied before each test.
- All test databases are dropped at the end.

To use another server, set `TEST_DATABASE_URL`, for example `postgres://user:pass@host:5432/postgres`. The user needs permission to create databases. If PostgreSQL can't be reached, the run stops with a message explaining how to start it.

### All scripts

| Command | What it does |
|---|---|
| `npm run dev` | Start with live reload and readable logs |
| `npm run build && npm start` | Compile to `dist/` and run as in production |
| `npm test` / `npm run typecheck` | Run the tests (needs PostgreSQL) / type-check |
| `npm run test:smoke` | End-to-end check against a running stack (`BASE_URL`, `API_KEY` optional) |
| `npm run db:up` | Start only the PostgreSQL container |
| `npm run db:migrate` | Apply pending migrations |
| `npm run db:generate` | Generate a new migration after editing `src/db/schema.ts` |
| `npm run db:seed` | Insert sample tasks |
| `npm run db:studio` | Open Drizzle Studio to browse the database |

## Configuration

All settings come from environment variables. A `.env` file is loaded if present (see [`.env.example`](.env.example)). Invalid values stop the server at startup with a clear message.

| Variable | Default | Description |
|---|---|---|
| `DATABASE_URL` | `postgres://tasks:tasks@localhost:5432/tasks` | PostgreSQL connection string. The default matches the compose `postgres` service. |
| `DB_POOL_MAX` | `10` | Maximum connections in the pool |
| `PORT` | `3000` | HTTP port |
| `API_KEY` | *(unset)* | When set (16+ characters), every `/api/v1` request needs `Authorization: Bearer <key>`. Unset means no auth, for easy local use. |
| `RATE_LIMIT_WINDOW_MS` / `RATE_LIMIT_MAX` | `60000` / `100` | Requests allowed per client IP per window |
| `TRUST_PROXY` | `0` | Number of reverse proxies in front of the app, so the real client IP is used for rate limiting |
| `LOG_LEVEL` | `info` | `fatal` `error` `warn` `info` `debug` `trace` `silent` |
| `NODE_ENV` | `development` | `development` gives readable logs; anything else gives JSON logs |

For docker-compose, `POSTGRES_PORT` and `API_PORT` change the ports on your machine if 5432 or 3000 are already in use.

## API

Base path: `/api/v1`. The full contract is in the OpenAPI 3.1 document at `/openapi.json`, also browsable at `/docs`.

| Method | Path | Description | Success |
|---|---|---|---|
| `POST` | `/tasks` | Create a task | `201` + `Location` + `ETag` |
| `GET` | `/tasks` | List tasks with filters, sorting and pagination | `200` |
| `GET` | `/tasks/:id` | Get one task | `200` + `ETag` |
| `PATCH` | `/tasks/:id` | Update some fields | `200` + `ETag` |
| `DELETE` | `/tasks/:id` | Delete a task | `204` |
| `GET` | `/health` | Health check, including the database (`503` if it's unreachable) | `200` |

### The Task resource

```json
{
  "id": "0b6f3a52-6c5e-4c1e-9a43-3c1f0f6f9b2e",
  "title": "Write API documentation",
  "description": "OpenAPI spec and README",
  "status": "todo",
  "priority": "medium",
  "dueDate": "2026-10-20T17:00:00.000Z",
  "version": 1,
  "createdAt": "2026-10-07T03:00:00.000Z",
  "updatedAt": "2026-10-07T03:00:00.000Z"
}
```

| Field | Rules |
|---|---|
| `title` | Required. Trimmed, 1–200 characters. |
| `description` | Optional, up to 5 000 characters, or `null`. |
| `status` | `todo` (default), `in_progress` or `done`. |
| `priority` | `low`, `medium` (default) or `high`. |
| `dueDate` | Optional ISO-8601 date-time with a timezone, or `null`. Stored in UTC. |

The server sets `id`, `version`, `createdAt` and `updatedAt`. If a client sends any of them, or any other unknown field, the request fails with 400 rather than having the field silently ignored.

### Filters for `GET /tasks`

| Parameter | Example | Meaning |
|---|---|---|
| `status` | `todo,in_progress` | Any of these statuses. `?status=a&status=b` also works. |
| `priority` | `high` | Any of these priorities |
| `q` | `deploy` | Case-insensitive substring match on title or description. `%` and `_` are matched literally. |
| `dueAfter` / `dueBefore` | `2026-10-01T00:00:00Z` | `dueDate >= dueAfter` and `dueDate < dueBefore` |
| `sort` | `-createdAt` (default) | `createdAt`, `updatedAt`, `title` or `priority`. Prefix with `-` for descending. Priority sorts by importance (`low < medium < high`), not alphabetically. |
| `limit` | `20` (default) | 1 to 100 |
| `cursor` | | The `nextCursor` value from the previous page |

Filters combine with AND. A misspelled parameter such as `?stauts=done` returns 400, so it can't quietly return every task.

```bash
curl 'localhost:3000/api/v1/tasks?status=todo,in_progress&sort=-priority&limit=10'
# → { "data": [ ...tasks ], "nextCursor": "eyJzb3J0Ijoi..." | null }
```

### Examples

```bash
# Create. The Idempotency-Key makes the request safe to retry.
curl -i -X POST localhost:3000/api/v1/tasks \
  -H 'Content-Type: application/json' -H 'Idempotency-Key: 7d1c0b9e' \
  -d '{"title":"Ship v1","priority":"high","dueDate":"2026-10-31T17:00:00+07:00"}'

# Update only if nobody else changed the task since we read version 1
curl -i -X PATCH localhost:3000/api/v1/tasks/<id> \
  -H 'Content-Type: application/json' -H 'If-Match: "1"' \
  -d '{"status":"done"}'

curl -i -X DELETE localhost:3000/api/v1/tasks/<id>
```

### Errors

Every error uses [RFC 9457](https://www.rfc-editor.org/rfc/rfc9457) `application/problem+json`. Each response includes the `requestId`, which matches the `X-Request-Id` header and the server logs.

```json
{
  "type": "about:blank",
  "title": "Validation Failed",
  "status": 400,
  "detail": "The request contains invalid fields",
  "instance": "/api/v1/tasks",
  "requestId": "5f0e7c1a-...",
  "errors": [{ "field": "title", "message": "String must contain at least 1 character(s)" }]
}
```

| Status | When |
|---|---|
| 400 | Invalid body, query, cursor or `If-Match` header, or malformed JSON |
| 401 | Auth is enabled and the API key is missing or wrong |
| 404 | The task or route doesn't exist (including ids that aren't UUIDs) |
| 409 | A request with the same `Idempotency-Key` is still being processed. Retry after the `Retry-After` delay. |
| 412 | The `If-Match` version is out of date (see below) |
| 413 | Body is larger than 100 kb |
| 415 | `POST` or `PATCH` without `Content-Type: application/json` |
| 422 | An `Idempotency-Key` was reused with a different payload |
| 429 | Rate limit exceeded. Check the `RateLimit` headers. |
| 500 | Unexpected error. Details are logged, never returned. |

## Design decisions

### Why Drizzle ORM

- **Schema in TypeScript.** [`src/db/schema.ts`](src/db/schema.ts) is the single source of truth. Row types come from it, and `drizzle-kit` generates plain SQL migrations from it ([`drizzle/`](drizzle/)), which are committed and reviewable.
- **Close to SQL.** Queries read like SQL and are type-checked. Where SQL is clearer, such as the row-value comparison used for pagination, the `sql` template still binds every value as a parameter.
- **Lightweight.** No code generation step and no separate query engine binary.

### Migrations run as their own step

Migrations don't run when the API starts. They run in a separate step: `npm run db:migrate`, or the one-shot `migrate` service in compose. The API waits for `service_completed_successfully`. If several API instances migrated on startup, they would race each other; and if a migration fails, the API should not start against a half-migrated schema.

### Safe concurrent updates (optimistic locking)

Every task has a `version`, returned as the `ETag` header. A client that sends `If-Match: "<version>"` on `PATCH` or `DELETE` gets **412** if someone else changed the task in the meantime, instead of silently overwriting their change (the "lost update" problem).

The check runs inside the SQL statement (`UPDATE … WHERE id = $1 AND version = $2`), so it holds across any number of API instances. When nothing matches, the service checks again to tell **404** (the task is gone) apart from **412** (the task changed). `If-Match` is optional, so simple clients keep working. A stricter API could require it and return `428` when it's missing.

### Safe retries (`Idempotency-Key`)

A client whose `POST` timed out can't tell whether the task was created. If it sends an `Idempotency-Key`, retrying is safe:

1. **Claim first.** Before doing any work, the server runs `INSERT … ON CONFLICT DO NOTHING` on the key. Only one request can win this, even when duplicates arrive at the same moment on different instances. This was checked against real Postgres: 5 simultaneous identical requests created 1 task.
2. **Retry after success:** returns the stored response byte-for-byte, with an `Idempotent-Replayed: true` header.
3. **Retry while the first is still running:** returns `409` with `Retry-After`.
4. **Same key, different payload:** returns `422`.
5. **First request failed** (validation error, crash): the key is released, so the client can fix the request and retry with the same key. A claim left unfinished for 60 seconds, for example after a process crash, can be taken over.
6. **Expiry:** records expire after 24 hours.

### Cursor pagination instead of offset

`LIMIT/OFFSET` gets slower as the offset grows, and skips or repeats rows when data changes between page requests. Here, each page continues from the last row seen, `(sort_value, id) > ($1, $2)`, using a composite index on `(column, id)`. That makes every page O(log n) and keeps pages stable while rows are inserted. Sorting always includes `id`, so rows with equal timestamps still come back in a fixed order (the tests freeze the clock to check this).

Timestamps are stored as `timestamptz(3)` (milliseconds) on purpose. Postgres defaults to microseconds, but JavaScript `Date` only has milliseconds. With the default, a cursor built from a JS date would point slightly *before* its own row, and that row would appear again on the next page.

The cursor is opaque base64url JSON tied to its `sort`. Its contents are validated before reaching SQL, so a forged cursor returns 400, not a Postgres cast error (500). There is no `total` count on purpose: it would cost a full scan on every page.

### Security

- **Authentication:** optional bearer API key. Keys are compared in constant time (both sides are SHA-256 hashed, then `timingSafeEqual`), and the check runs **before** the body is parsed.
- **Input validation:** zod validates every input at the boundary (body, query, headers, path ids, cursors). Unknown fields are rejected. Size limits apply to every string and to the whole body (100 kb).
- **SQL injection:** every value is a bound parameter. The only SQL fragments built in code are column names and casts taken from fixed allow-lists. There is a test for this.
- **Defense in depth:** the database repeats the validation rules with enum types, `varchar(200)` and `CHECK` constraints.
- **Database limits:** a 10-second `statement_timeout` and a connection timeout on the pool, so a slow query can't hold connections forever.
- **Headers:** `helmet` sets the security headers and removes `X-Powered-By`.
- **Rate limiting:** applied per IP, with standard `RateLimit` headers.
- **No leaks:** 500 responses never contain stack traces or SQL. The `Authorization` and `Cookie` headers are redacted from logs.
- **Docker:** the container runs as a non-root user.

### Code layout

```
src/
  server.ts            process entry: config, logger, pool, listen, graceful shutdown
  app.ts               builds the Express app from its dependencies (no I/O, so tests create one per test)
  config.ts            environment variables validated with zod
  db/
    schema.ts          Drizzle schema: tables, enums, indexes, CHECK constraints
    client.ts          node-postgres pool and a driver-agnostic `Database` type
    migrate.ts         applies drizzle/ migrations (run as a separate step)
  http/                cross-cutting HTTP code: errors, validation, auth, ETag, cursor, idempotency
  modules/tasks/
    task.schema.ts     API types and zod schemas
    task.repository.ts database access only
    task.service.ts    business rules: versioning, pagination, not-found vs conflict
    task.routes.ts     HTTP only: parse input, call the service, set headers
  docs/openapi.ts      OpenAPI 3.1 document, served at /docs
drizzle/               generated SQL migrations (committed)
test/                  integration tests (supertest) against real PostgreSQL
  support/             global setup: template database, one cloned database per test file
scripts/smoke-test.sh  end-to-end check, used by CI against the Docker stack
.github/               CI/CD workflow and Dependabot config
```

## Tests

`npm test` runs 71 tests in about 2 seconds against PostgreSQL:

| File | Covers |
|---|---|
| `tasks.crud.test.ts` | Create, read, update, delete; defaults; trimming; UTC normalization; every validation rule; 404/415 and malformed JSON |
| `tasks.list.test.ts` | Each filter and their combinations; literal `%`/`_` in search; sorting, including priority order; full page walks with tied timestamps for every sort; stable pages during inserts; bad cursors |
| `tasks.concurrency.test.ts` | Lost-update prevention with `If-Match`; 412 vs 404; `*`; malformed headers |
| `idempotency.test.ts` | Replay; truly concurrent duplicates (separate pool connections); 409 while in progress; taking over an abandoned claim; payload mismatch; failed requests not stored; 24-hour expiry |
| `security.test.ts` | Auth (and that it runs before body parsing); security headers; 413; 429; SQL injection; malformed ids and cursors never reaching Postgres; request-id handling; generic 500s; 503 health when the pool is down |
| `persistence.test.ts` | Data survives a restart (new connection pool); re-running migrations is a no-op; database constraints (checked by SQLSTATE code); config validation |

## CI/CD

[`.github/workflows/ci.yml`](.github/workflows/ci.yml) runs on every push to `main` and on every pull request. The workflow treats this folder as the repository root.

> GitHub only runs workflows from `.github/workflows/` at the root of a repository. This one runs as-is when this folder is pushed as its own repository. In the combined challenge repository, copy it to the root and add `working-directory: src/problem5`.

| Job | What it checks |
|---|---|
| **test** | `npm ci`, typecheck, **migration drift check**, build, and the full test suite against a PostgreSQL 17 service container. The drift check fails if `src/db/schema.ts` changed but the generated migration wasn't committed. |
| **docker** | Builds the image and starts the real compose stack (postgres → migrate → api), then runs [`scripts/smoke-test.sh`](scripts/smoke-test.sh). That script checks health, create, read, a conditional update and a stale-version 412, filtering, and delete. It prints container logs if anything fails. |
| **publish** (CD) | Only on `main`, and only after both jobs pass. Pushes the image to GitHub Container Registry as `ghcr.io/<owner>/tasks-api:<commit-sha>` and `:latest`, with build layers cached between runs. |

Deploying is then a matter of pointing the target environment at a new image tag and running the `migrate` command before switching traffic. The deployment target itself is outside the scope of this challenge. [Dependabot](.github/dependabot.yml) opens weekly update PRs for npm packages, the base Docker image and the GitHub Actions used.

## Assumptions and next steps

**Assumptions**

- **One tenant.** Authentication protects the service as a whole. Per-user ownership (a `user_id` on each task plus JWT auth) is the next step if tasks belong to individual users.
- **Hard delete.** Deleted tasks are removed. Soft delete (`deleted_at`) would be easy to add if recovery or auditing is needed.
- **`PATCH` only, no `PUT`.** Partial updates cover "update resource details", and `null` clears optional fields.

**For production at scale**

- **Faster search:** a `pg_trgm` GIN index for `q`. Today's `ILIKE '%…%'` is a full scan, fine for thousands of rows.
- **Shared rate limiting:** a Redis-backed store, so limits apply across instances. The current limiter is in-memory, per process.
- **Scoped idempotency keys:** scope them per API client once there are several clients.
- **Operations:** OpenTelemetry traces and metrics, PgBouncer when there are many instances, and lint plus `npm audit` steps in CI.
