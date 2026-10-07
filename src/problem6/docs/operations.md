# Configuration and observability

*Part of the [scoreboard module specification](../README.md).*

## Configuration

Per action type (`action_types` table, editable without a deploy):

| Field | Example: `quiz_round` | Meaning |
|---|---|---|
| `points` | `10` | Points awarded per valid completion |
| `min_duration` | `20 seconds` | Faster completions are rejected as implausible |
| `session_ttl` | `10 minutes` | A session must be completed within this time |
| `enabled` | `true` | Disable a type instantly, for example if it's being exploited |

Module-wide settings (environment variables, defaults in brackets):

| Setting | Default |
|---|---|
| `SCORE_MAX_OPEN_SESSIONS` | `3` |
| `SCORE_CAP_HOURLY` / `SCORE_CAP_DAILY` | `600` / `3000` |
| `RATE_START_PER_MIN` / `RATE_COMPLETE_PER_MIN` | `30` / `30` |
| `ABUSE_VIOLATIONS_BEFORE_BLOCK` / `ABUSE_BLOCK_BASE` | `10` / `15m` |
| `RISK_REVIEW_THRESHOLD` / `RISK_SUSPEND_THRESHOLD` | `50` / `100` |
| `TOP10_MIN_ACCOUNT_AGE` | `7d` |
| `SSE_COALESCE_MS` / `SSE_HEARTBEAT_S` / `SSE_MAX_PER_INSTANCE` / `SSE_MAX_PER_IP` | `500` / `15` / `10000` / `5` |
| `SSE_RETRY_MIN_MS` / `SSE_RETRY_MAX_MS` | `1000` / `5000` |
| `COMPLETE_DEADLINE_MS` / `COMPLETE_MAX_INFLIGHT` | `1000` / `200` |
| `PG_POOL_REQUEST` / `PG_POOL_WORKER` / `PG_ACQUIRE_TIMEOUT_MS` | `10` / `3` / `200` |
| `PG_LOCK_TIMEOUT_MS` / `PG_STATEMENT_TIMEOUT_MS` | `300` / `500` |
| `REDIS_COMMAND_TIMEOUT_MS` / `REDIS_POOL` | `50` / `10` |
| `BREAKER_FAILURE_RATE` / `BREAKER_WINDOW` / `BREAKER_OPEN_MS` | `0.5` / `20 calls or 10 s` / `5000` |
| `RETRY_BUDGET_RATIO` | `0.1` |

## Observability

**Metrics** (Prometheus names):

| Metric | Why |
|---|---|
| `score_completions_total{result}` | `result` is `awarded`, `replayed`, `too_fast`, `cap_exceeded`, `expired` or `not_found`. A jump in rejections means an attack or a client bug. |
| `score_completion_duration_seconds` | Latency of the completion endpoint (p99 target 150 ms) |
| `rate_limit_rejections_total{layer}` / `abuse_blocks_total` | Volume of scripted traffic |
| `outbox_lag_seconds` | Age of the oldest unpublished outbox row. This is the main health signal for the live board. |
| `leaderboard_publish_total` / `leaderboard_propagation_seconds` | How often the top 10 changes, and commit-to-viewer latency (p95 target 1 s) |
| `sse_connections{instance}` / `sse_dropped_slow_total` | Viewer load and slow clients |
| `risk_flags_total{status}` / `reconciliation_corrections_total` | Abuse detected, and Redis drift fixed |
| `abuse_rule_triggers_total{rule}` | How often each anti-abuse rule fires. A rule that stays at zero for weeks is checked for bugs (see [Implementation checklist: common mistakes](security.md#implementation-checklist-common-mistakes)). |
| `circuit_breaker_state{dependency}` | 0 closed, 1 half-open, 2 open |
| `db_pool_in_use{pool}` / `db_pool_wait_seconds` / `load_shed_total{endpoint}` | Pool saturation, and requests shed by bulkheads |
| `retries_total{operation}` / `retry_budget_exhausted_total` | Retry volume, and when the retry budget stopped further retries |

**Alerts:**

- `outbox_lag_seconds > 10` for 2 minutes;
- rejection rate above 5× its 7-day baseline;
- any `reconciliation_corrections_total` increase in the top 10;
- SSE connections above 80% of capacity;
- any circuit breaker open for more than 1 minute;
- request pool in use above 80% for 5 minutes.

**Logs and tracing:**

- Structured logs with request id and `userId`.
- Rejections log at `warn` with their reason.
- A trace spans the HTTP request, the transaction and the outbox publish, linked by the outbox row id.
