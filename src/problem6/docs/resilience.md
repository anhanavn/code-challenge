# Resilience and failure handling

*Part of the [scoreboard module specification](../README.md).*

PostgreSQL is the **only source of truth**. Redis holds derived data that can always be rebuilt (see [ADR-0003](adr/0003-ledger-source-of-truth-redis-read-model.md)). Every call to a dependency has a timeout, a retry policy and a defined behavior when the dependency fails.

## Resilience patterns

| Pattern | Where it applies | Summary |
|---|---|---|
| Timeouts | Every network call and every transaction | A 1-second deadline per completion request, divided across its steps (see [Timeouts](#timeouts)) |
| Connection pools | PostgreSQL and Redis | Sized with Little's law; separate pools per workload (see [Connection pools](#connection-pools)) |
| Retry with exponential backoff and jitter | Only operations that are safe to repeat | Who retries what, and how (see [Retries with exponential backoff and jitter](#retries-with-exponential-backoff-and-jitter)) |
| Circuit breakers | Redis, PostgreSQL | Fail fast and degrade gracefully instead of waiting on timeouts (see [Circuit breakers](#circuit-breakers)) |
| Bulkheads and load shedding | Pools, per-endpoint concurrency, connection caps | One workload can't starve another (see [Bulkheads and load shedding](#bulkheads-and-load-shedding)) |
| Rate limits | Edge, user, IP, points | [Layered rate limits](security.md#layered-rate-limits) |
| Reconciliation | Redis against PostgreSQL, totals against the ledger | Detects and repairs drift (see [Reconciliation](#reconciliation)) |

These patterns are safe together because of **idempotency**: completing an action twice awards nothing extra, `ZADD GT` and publish-if-changed can be replayed, and outbox delivery is at-least-once. Any timeout can therefore be followed by a retry without corrupting state.

## Timeouts

A completion request has a **1-second server-side deadline**, against a p99 target of 150 ms. Each step gets a slice of it, and the request is abandoned (transaction rolled back, `503` with `Retry-After: 1`) as soon as the deadline passes:

| Step | Timeout | Notes |
|---|---|---|
| Redis command (rate limit, block list) | 50 ms | On timeout, the circuit breaker counts a failure and the local fallback limiter is used (see [Circuit breakers](#circuit-breakers)) |
| PostgreSQL pool acquire | 200 ms | Waiting longer means the database is saturated; fail fast instead of queueing |
| Row lock (`lock_timeout`) | 300 ms | Bounds how long a user's concurrent completions wait for each other |
| Each statement (`SET LOCAL statement_timeout`) | 500 ms | Normal statements take ~1 ms |
| `idle_in_transaction_session_timeout` | 5 s | The database's safety net if a process stalls mid-transaction |
| PostgreSQL / Redis connect | 1 s / 500 ms | |
| Workers (outbox relay, reconciliation) | 5 s per batch | Not on the request path, so more generous |

Clients should time a request out at 3 seconds and retry it (see [Retries with exponential backoff and jitter](#retries-with-exponential-backoff-and-jitter)).

## Connection pools

Size pools with **Little's law**: connections in use = throughput × time per transaction. At 250 completions/s per instance and ~5 ms per transaction, that's about 1.3 connections in use. A pool of 10 gives ~8× headroom for bursts and slow moments. A bigger pool doesn't help; it only adds load on PostgreSQL.

| Pool (per instance) | Size | Used by |
|---|---|---|
| PostgreSQL, request pool | 10 | Start, complete, leaderboard fallback |
| PostgreSQL, worker pool | 3 | Outbox relay, risk evaluator, reconciliation |
| Redis, command pool | 10 | Rate limits, sorted-set reads and writes |
| Redis, subscriber connection | 1 dedicated | Pub/sub. A subscribed connection can't run other commands. |

Rule: instances × (request + worker pool) must stay **below 70% of PostgreSQL `max_connections`**. With `max_connections = 200`, that allows about 10 instances. Beyond that, put **PgBouncer** in transaction mode in front of PostgreSQL (see [Scaling: 100 → 1 000 → 1 000 000](scaling.md#scaling-100--1-000--1-000-000)).

## Retries with exponential backoff and jitter

Delay before retry *n*: `random(0, min(cap, base × 2ⁿ))`, the "full jitter" variant. The randomness spreads retries out, so failed clients don't come back in synchronized waves.

| Who | Operation | Retry? | Policy |
|---|---|---|---|
| Client | Completion: timeout, network error, 5xx | **Yes**, because it's idempotent | base 250 ms, cap 8 s, at most 5 attempts |
| Client | Any request: 429 or 503 | Yes | Wait for `Retry-After`, plus 0–20% jitter |
| Client | Other 4xx | **Never** | The request is wrong; repeating it won't help |
| Client | Start action: network error | Once | A duplicate session is harmless: it counts against the 3-open-session limit and expires |
| API | Completion transaction: deadlock, serialization failure, lock timeout (SQLSTATE `40P01`, `40001`, `55P03`) | Up to 2 times | base 10 ms, cap 50 ms, within the request deadline |
| API | Redis call on the request path | No | Use the fallback instead (see [Circuit breakers](#circuit-breakers)). Retrying would add latency to every request. |
| Outbox relay | Redis `ZADD` / publish | Yes, until it succeeds | base 100 ms, cap 10 s. Rows stay in the outbox, so nothing is lost while it waits. |
| SSE hub | Redis subscription lost | Yes, until it succeeds | base 100 ms, cap 10 s. After resubscribing, reload the latest snapshot; missed messages don't matter in the snapshot model. |
| Browser | Stream reconnect | Automatic | The server sends a randomized `retry` of 1–5 s. The client SDK backs off exponentially, up to 60 s, after repeated failures. |

**Retry budget:** server-side retries are capped at 10% of requests per instance, so retries can't multiply the load during an outage (a retry storm).

## Circuit breakers

A breaker stops calling a failing dependency for a short time. Requests fail fast or degrade, instead of each waiting out its timeout while holding a connection.

| Dependency | Opens when | While open | Recovery |
|---|---|---|---|
| **Redis** | ≥ 50% of the last 20 calls fail or time out (within 10 s), or 5 consecutive timeouts | Rate limiting switches to **in-memory token buckets** on each instance, at the per-user limit ÷ number of instances (stricter overall). The block list is served from a local copy refreshed every 30 s. The relay pauses and its rows wait in the outbox. Reads are served from the in-memory snapshot. **Completions keep working**, and points caps stay exact because they're enforced in PostgreSQL. | After 5 s, one probe call; the breaker closes after 3 successful probes |
| **PostgreSQL** | ≥ 50% of the last 20 calls fail, or pool acquire times out repeatedly | Start and complete return `503` immediately with `Retry-After`. Nothing is acknowledged that isn't stored. The board keeps being served from memory and Redis. | After 5 s, one probe call |

## Bulkheads and load shedding

Resources are partitioned so a problem in one workload can't take down another:

- **Separate PostgreSQL pools** for requests and background workers. A slow reconciliation query can't use up the connections that completions need.
- **A concurrency limit per endpoint:** at most 200 in-flight completions per instance. Above that, return `503` with `Retry-After: 1` immediately (load shedding), which protects stream and read traffic on the same instance.
- **SSE connection caps** per instance (10 000) and per IP (5), so streams can't exhaust memory or file descriptors needed by API requests.
- **A dedicated Redis subscriber connection**, so pub/sub never competes with rate-limit commands.
- **Background workers** run at concurrency 1, each behind a feature flag so it can be switched off during an incident.
- **At larger scale, separate processes and clusters** (see [Scaling: 100 → 1 000 → 1 000 000](scaling.md#scaling-100--1-000--1-000-000)): streams move to their own gateway deployment, and rate limiting gets its own Redis cluster so attack traffic can't slow the board.

## Failure modes

| Failure | Behavior |
|---|---|
| **Process crashes after commit, before Redis is updated** | The outbox row is committed together with the points, so a relay publishes it later. There's no gap between "points saved" and "board updated eventually". |
| **Redis down or slow** | Its breaker opens (see [Circuit breakers](#circuit-breakers)). Completions continue with local rate limiting, the board is served from memory, and streams stay open with heartbeats. The outbox backlog drains when Redis recovers. |
| **Redis data lost** | When `lb:alltime` is missing, rebuild it from `user_scores` (only users whose risk status is `ok`) into a temporary key, then `RENAME` it into place atomically, so the board is never briefly empty. |
| **PostgreSQL down** | Its breaker opens. Completions return 503. The board keeps being served. |
| **Relay delivers an outbox row twice** | `ZADD GT` is idempotent, and publish-if-changed suppresses the duplicate. |
| **One instance dies** | Its viewers reconnect to other instances (jittered) and get the current snapshot from memory. Its outbox rows are taken by other relays (`SKIP LOCKED`). |

## Reconciliation

Derived data is checked against the source of truth on a schedule. Every correction increments `reconciliation_corrections_total` and is logged:

| Job | Frequency | Compares | Repair |
|---|---|---|---|
| Board check | 1 min | Top 100 in Redis vs top 100 in `user_scores` (users with risk status `ok`) | `ZADD` / `ZREM` the differences and republish |
| Sorted-set audit | Daily | Member count and a 1% random sample of scores | Rebuild atomically (see [Failure modes](#failure-modes)) if drift exceeds 0.1% |
| Ledger vs totals | Nightly | For users with events in the last day: `user_scores.score` vs `SUM(score_events.points)` | The ledger wins. Fix the total and alert, because a mismatch means a bug. |
| Outbox health | Continuous | Unpublished rows older than 30 s | Alert (relay stuck, or Redis breaker open for too long) |
| Session cleanup | Hourly | `started` sessions past `expires_at` | Mark them expired; delete sessions older than 30 days |
