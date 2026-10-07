# Score update flow and data model

*Part of the [scoreboard module specification](../README.md).*

## Score update flow

### Sequence

```mermaid
sequenceDiagram
    autonumber
    actor U as User
    participant API as API instance
    participant PG as PostgreSQL
    participant W as Outbox relay
    participant R as Redis
    participant H as SSE hubs

    U->>API: POST /v1/actions {type} + bearer token
    API->>R: token bucket check (user, IP)
    API->>PG: open sessions < limit? INSERT action_session (started)
    API-->>U: 201 {actionId, expiresAt}

    Note over U: user performs the action

    U->>API: POST /v1/actions/{id}/complete + bearer token
    API->>R: token bucket check (user, IP)
    API->>PG: BEGIN, lock user_scores row
    API->>PG: claim session with conditional UPDATE
    alt claimed and within caps
        API->>PG: INSERT score_event, UPDATE user_scores, INSERT outbox, COMMIT
        API-->>U: 200 {pointsAwarded, totalScore}
    else already completed by this user
        API-->>U: 200 stored result (Idempotent-Replayed: true)
    else expired, too fast or over cap
        API->>PG: mark session rejected, COMMIT
        API-->>U: 409 / 422 / 429 problem+json
    end

    W->>PG: fetch outbox rows (FOR UPDATE SKIP LOCKED)
    W->>R: ZADD leaderboard GT score user
    opt new score can reach the top 10
        W->>PG: build ordered top 10 with display names
        W->>R: publish-if-changed script (compare, INCR version, PUBLISH)
    end
    W->>PG: mark outbox rows published
    R-->>H: snapshot message (fan-out to every instance)
    H-->>U: SSE event snapshot (coalesced)
```

### Completion decision

The order matters. The cheap checks that need no database run first, and every check that changes state runs inside the transaction.

```mermaid
flowchart TD
    A["POST /v1/actions/:id/complete"] --> B{"Access token valid?"}
    B -- no --> E401["401 unauthenticated"]
    B -- yes --> BL{"User blocked or<br/>rate limit exceeded?"}
    BL -- yes --> E429["403 temporarily_blocked<br/>or 429 rate_limited"]
    BL -- no --> C{"Session exists and<br/>belongs to this user?"}
    C -- no --> E404["404 action_not_found"]
    C -- yes --> D{"Session status"}
    D -- completed --> R200["200 stored result<br/>Idempotent-Replayed: true"]
    D -- rejected --> E409a["409 action_rejected"]
    D -- started --> F{"Expired?"}
    F -- yes --> E409b["409 action_expired"]
    F -- no --> G{"Elapsed time >= minimum<br/>for this action type?"}
    G -- no --> X1["mark rejected: too_fast<br/>+ risk signal"] --> E422["422 completion_too_fast"]
    G -- yes --> H{"Within hourly and<br/>daily points caps?"}
    H -- no --> X2["mark rejected: cap_exceeded<br/>+ risk signal"] --> E429b["429 score_cap_exceeded"]
    H -- yes --> OK["award points in the same transaction<br/>200 pointsAwarded, totalScore"]
```

### Error codes

Errors use RFC 9457 `application/problem+json`, with a stable machine-readable `code`:

| Status | `code` | Meaning |
|---|---|---|
| 400 | `invalid_request` | Invalid body. Unknown fields such as `points` or `score` are rejected. |
| 401 | `unauthenticated` | Missing or invalid access token |
| 403 | `temporarily_blocked` | The user is blocked for repeated violations. `Retry-After` says for how long. |
| 404 | `action_not_found` | No such action **for this user**. Other users' actions also return 404, so ids can't be probed. |
| 409 | `action_expired` / `action_rejected` | The action can no longer be completed |
| 422 | `action_type_unknown` / `completion_too_fast` | Unknown action type, or completed faster than humanly possible |
| 429 | `rate_limited` / `too_many_open_actions` / `score_cap_exceeded` / `too_many_connections` | Request rate, open-session, points or stream-connection limit hit. `Retry-After` is included. |
| 503 | `service_unavailable` | PostgreSQL is unavailable, the request deadline passed, or the instance is shedding load. Nothing was changed; retry with backoff. |

### The transaction

Everything that awards points happens in **one** PostgreSQL transaction, so the five steps succeed or fail together:

```sql
BEGIN;

-- 1. Serialize this user's completions so the caps below are exact. Different users never wait on each other.
--    The user_scores row is created with score 0 the first time the user starts an action.
SELECT score FROM user_scores WHERE user_id = $user FOR UPDATE;

-- 2. Claim the session. Only one request can win: single use, owner-bound, unexpired, plausible duration.
UPDATE action_sessions s
SET    status = 'completed', completed_at = now(), points_awarded = t.points
FROM   action_types t
WHERE  s.id = $action AND s.user_id = $user AND s.type = t.type
  AND  s.status = 'started' AND s.expires_at > now()
  AND  now() - s.started_at >= t.min_duration
RETURNING t.points;
-- No row: read the session to choose 200 replay / 404 / 409 / 422 (see [Completion decision](#completion-decision)).
-- A too-fast attempt is marked 'rejected' in this same transaction and then committed.

-- 3. Points caps: sum over at most a few dozen rows, using the (user_id, created_at) index.
SELECT coalesce(sum(points), 0) FROM score_events
WHERE  user_id = $user AND created_at > now() - interval '1 hour';   -- and the same for 24 hours

-- 4. Ledger entry. The UNIQUE constraint on action_id is a second guarantee against double counting.
INSERT INTO score_events (user_id, action_id, points) VALUES ($user, $action, $points);

-- 5. New total, stored on the session too so replays return the identical response. Then the outbox row.
UPDATE user_scores SET score = score + $points, reached_at = now() WHERE user_id = $user RETURNING score;
UPDATE action_sessions SET total_after = $score WHERE id = $action;
INSERT INTO outbox (topic, payload) VALUES ('score.changed', '{"userId": …, "score": …, "reachedAt": …}');

COMMIT;
```

**Why lock the `user_scores` row?** Without it, two simultaneous completions by the same user could both read "under the cap" and both commit. Locking one row per user makes the caps exact. It costs nothing in practice, because only completions by the *same* user wait for each other.

## Data model

```mermaid
erDiagram
    users ||--o| user_scores : "has total"
    users ||--o{ action_sessions : starts
    action_types ||--o{ action_sessions : configures
    action_sessions ||--o| score_events : "awards at most one"
    users ||--o{ score_events : earns
    users ||--o| user_risk : "risk state"

    users {
        uuid id PK
        text display_name
        timestamptz created_at
    }
    action_types {
        text type PK
        int points
        interval min_duration
        interval session_ttl
        bool enabled
    }
    action_sessions {
        uuid id PK
        uuid user_id FK
        text type FK
        session_status status
        text reject_reason
        timestamptz started_at
        timestamptz expires_at
        timestamptz completed_at
        int points_awarded
        bigint total_after
        inet client_ip
    }
    score_events {
        bigint id PK
        uuid user_id FK
        uuid action_id UK
        int points
        text kind
        timestamptz created_at
    }
    user_scores {
        uuid user_id PK
        bigint score
        timestamptz reached_at
    }
    user_risk {
        uuid user_id PK
        int risk_score
        risk_status status
        jsonb reasons
        timestamptz updated_at
    }
    outbox {
        bigint id PK
        text topic
        jsonb payload
        timestamptz created_at
        timestamptz published_at
    }
```

| Table | Notes |
|---|---|
| `action_sessions` | `status`: `started`, `completed` or `rejected`. Expiry is computed from `expires_at`; a cleanup job deletes sessions older than 30 days. Indexes: `(user_id, status)` for the open-session limit, `(expires_at)`. |
| `score_events` | **Append-only ledger** and the audit trail. `kind`: `award` or `reversal`. Reversals are negative rows that point at the original, so totals can always be recomputed exactly. `UNIQUE (action_id)` (ignoring reversal rows); index `(user_id, created_at)`. |
| `user_scores` | The current total, derived from the ledger. Index `(score DESC, reached_at ASC)` serves the database fallback for the top 10. |
| `user_risk` | `status`: `ok`, `under_review` or `suspended`. Only `ok` users are present in the public sorted set. |
| `outbox` | Transactional outbox. Partial index on `published_at IS NULL`. Published rows are deleted after 7 days. |

```mermaid
stateDiagram-v2
    [*] --> started: POST /v1/actions
    started --> completed: valid completion, points awarded
    started --> rejected: too fast or over cap
    started --> expired: expires_at passed
    completed --> [*]
    rejected --> [*]
    expired --> [*]
```
