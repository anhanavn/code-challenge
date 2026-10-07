# ADR-0004: Synchronous database writes now; write-behind only past a measured threshold

**Status:** accepted

## Context

Design review proposed accepting score updates into a cache (for example Redis, possibly over a socket) and batch-inserting them into the database, to reduce database load.

## Decision

v1 writes every award **synchronously** in one PostgreSQL transaction (ADR-0003). Write-behind is planned, but adopted **only** when PostgreSQL write latency is measurably the bottleneck: roughly over 2 000 score updates/s sustained, versus a target of 200/s with 1 000/s bursts.

If it becomes necessary, write-behind must go through a **durable log**, never a plain cache:

1. A Redis Lua script atomically does the single-use claim (`SET action:{id} NX`), the caps check, `ZADD`, and `XADD` to a Redis Stream. Redis runs with AOF `appendfsync everysec` or stricter.
2. A consumer group batch-inserts into the ledger with `ON CONFLICT (action_id) DO NOTHING`, and acknowledges (`XACK`) only after commit.
3. Reconciliation between Redis and PostgreSQL becomes mandatory.

## Why not now

| Concern | Synchronous (v1) | Write-behind |
|---|---|---|
| Durability of acknowledged points | Committed to PostgreSQL before the response | Up to ~1 s of acknowledged points can be lost if Redis fails (AOF everysec) |
| Sources of truth | One | Two: Redis leads, PostgreSQL follows |
| Single-use and caps enforcement | One SQL transaction | Must be rebuilt in Lua, with care for every edge case |
| Audit and reversal | Immediate | Delayed until each batch commits |
| Throughput needed at target | ~200/s, about 10% of one PostgreSQL primary | Not needed |
| Operational complexity | Low | Stream consumers, lag monitoring, replay tooling |

## Consequences

- Simpler v1 with stronger guarantees. The measured trigger (`score_completion_duration_seconds`, PostgreSQL write latency) is in [Configuration and observability](../operations.md).
- The API contract doesn't change if write-behind is adopted later. Only the internals of the completion endpoint change.
