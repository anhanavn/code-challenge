# Acceptance criteria and implementation plan

*Part of the [scoreboard module specification](../README.md).*

## Acceptance criteria

These criteria define "done", and each should become an automated test (integration tests against real PostgreSQL and Redis):

| ID | Scenario | Expected |
|---|---|---|
| AC-1 | Start and complete an action after the minimum duration | 200. `pointsAwarded` comes from configuration, the total increases by exactly that amount, and there is one ledger row. |
| AC-2 | Send the same completion again | 200, the same body, `Idempotent-Replayed: true`, and the total is unchanged |
| AC-3 | 50 parallel completions of one action | Exactly 1 ledger row. Every response is 200 with an identical body. |
| AC-4 | Complete another user's action | 404 `action_not_found`. No state changes. |
| AC-5 | Complete before the minimum duration | 422 `completion_too_fast`. The session is `rejected`, the total is unchanged, and a risk signal is recorded. |
| AC-6 | Complete after `expires_at` | 409 `action_expired` |
| AC-7 | Points cap reached, including 20 parallel completions across different sessions | No commit exceeds the cap. Extra requests get 429 `score_cap_exceeded`. |
| AC-8 | Exceed the completion rate limit | 429 with `Retry-After`, and the database isn't queried |
| AC-9 | 10 violations within 10 minutes | 403 `temporarily_blocked` for 15 minutes. A second block lasts 30 minutes. |
| AC-10 | A request body containing `points` or `score` | 400. Unknown fields are rejected. |
| AC-11 | A completion moves a user into the top 10 | Connected SSE clients receive a new snapshot with a higher `version` within 1 s |
| AC-12 | A completion that doesn't change the top 10 | No publish happens |
| AC-13 | 100 top-10 changes within 1 s | Each client receives ≤ 3 events, and the last one is the final state |
| AC-14 | Kill the process between commit and the Redis update | After restart the board reflects the points: the outbox row is published |
| AC-15 | Flush Redis | The board is rebuilt from PostgreSQL and matches `user_scores` |
| AC-16 | Redis unavailable | Completions return 503, `GET /v1/leaderboard` is served from PostgreSQL, and recovery is automatic |
| AC-17 | User flagged `under_review` | Removed from the public top 10 within 1 s. The user still sees their own total. |
| AC-18 | Equal scores | The user who reached the score first ranks higher |
| AC-19 | 1 000 `GET /v1/leaderboard` requests on a warm instance | Zero Redis or PostgreSQL queries (served from memory); `If-None-Match` with the current version returns 304 |
| AC-20 | An instance with 5 000 streams restarts | Reconnections spread over 1–5 s (jittered `retry`), and the database sees no extra load |
| AC-21 | A request carries a `userId` for a different user | 400. Identity comes only from the token. |
| AC-22 | Add 2 s of latency to Redis | The Redis breaker opens. Completion p99 stays under 1 s, using local rate limiting. |
| AC-23 | Saturate the worker pool (for example with a slow reconciliation query) | Completion latency is unaffected (bulkhead) |
| AC-24 | More than 200 concurrent completions on one instance | The excess gets `503` with `Retry-After` immediately; no request waits past its deadline |
| AC-25 | Force a deadlock between two completions | The transaction is retried automatically, and both requests succeed |

Load test (k6) before launch: 1 000 completions/s and 20 000 SSE viewers for 30 minutes, meeting the latency targets in [Assumptions and design targets](scaling.md#assumptions-and-design-targets).

## Implementation plan

Each step can ship on its own behind the feature flag `scoreboard_v2`:

1. **Schema and write path.** Migrations, start and complete endpoints, the transaction, layered rate limits. Covers AC-1 to AC-10, AC-21 and AC-24 to AC-25.
2. **Read model.** Outbox relay, sorted set, publish-if-changed, `GET /v1/leaderboard` with database fallback, rebuild and reconciliation. Covers AC-12, AC-14 to AC-16, AC-18, AC-19 and AC-22 to AC-23.
3. **Live updates.** SSE hub with coalescing, connection limits and heartbeats. Infrastructure: proxy buffering off, load balancer timeouts. Covers AC-11, AC-13 and AC-20.
4. **Anti-abuse.** Risk evaluator, statuses, top-10 admission, and the review endpoints for the admin tool. Covers AC-17.
5. **Launch.** Load test, dashboards and alerts. Shadow mode first: compute scores but hide the board. Then turn the flag on for a percentage of users, then everyone.
