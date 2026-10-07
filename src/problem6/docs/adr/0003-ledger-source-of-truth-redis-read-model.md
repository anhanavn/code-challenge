# ADR-0003: PostgreSQL ledger as the source of truth, Redis sorted set as a rebuildable read model

**Status:** accepted

## Context

Scores must never be lost once acknowledged, and they must be auditable and reversible when abuse is confirmed. The top 10 must be cheap to compute on every change.

## Decision

1. **PostgreSQL is the only source of truth.** Each award is an append-only row in `score_events`, and `user_scores` holds the running total. Both are written in the same transaction that claims the action session.
2. **Transactional outbox.** The same transaction inserts an `outbox` row. A relay worker publishes it to Redis afterwards, so a crash between commit and publish delays the board update but never loses it.
3. **Redis sorted set `lb:alltime` is a derived read model.** It's written only from committed totals with `ZADD … GT`, which is idempotent and ignores stale, lower values that arrive late. A reconciliation job fixes drift. If the data is lost, the set is rebuilt from `user_scores`.
4. **Corrections are reversals, not edits.** Confirmed abuse adds negative ledger rows that point at the original rows, and the totals are recomputed from them.

## Alternatives considered

| Alternative | Why not |
|---|---|
| Redis as the primary store (`ZINCRBY` on completion) | Acknowledged points depend on Redis persistence settings. `ZINCRBY` isn't idempotent, so a retried request would double-count. No audit trail. |
| Write to PostgreSQL, then to Redis in the request (dual write) | A crash or a Redis error between the two writes leaves the board permanently missing the update. The outbox removes that gap. |
| Computing the top 10 from PostgreSQL on every change | `ORDER BY score DESC LIMIT 10` on an index is fast, but running it per change across instances adds database load. Redis does it in microseconds. It remains the fallback when Redis is down. |
| Change data capture (Debezium) instead of an outbox table | A good fit at larger scale, but it means running Kafka Connect. The outbox table gives the same guarantee using only PostgreSQL. |

## Consequences

- The board is **eventually consistent**: typically under 100 ms behind the database, and it never shows points that weren't committed.
- One extra insert per award (the outbox row), plus a background relay. Published rows are cleaned up after 7 days.
- The ledger grows without limit and is partitioned by month ([Assumptions and design targets](../scaling.md#assumptions-and-design-targets)). It also serves as the training data for abuse detection.
