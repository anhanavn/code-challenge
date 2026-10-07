# Security and anti-abuse

*Part of the [scoreboard module specification](../README.md).*

## Threats and controls

| Threat | Control |
|---|---|
| Changing the score without an account | Every write endpoint requires a valid access token (existing middleware). |
| **Sending a made-up number of points** | Not possible: no endpoint accepts points or scores. Points come from `action_types` on the server. |
| **Replaying a completion** (same request sent again) | The session is single-use: a conditional `UPDATE … WHERE status = 'started'`, plus `UNIQUE (action_id)` on the ledger. A replay gets the **stored original response** and earns nothing. |
| **Sending the same completion many times in parallel** | Only one conditional `UPDATE` can match. The rest see `completed` and get the stored response. Acceptance test AC-3 covers this. |
| Completing another user's action | The session is bound to `user_id` from the token. Someone else's id returns 404. |
| Guessing action ids | Random UUIDs, owner-bound, and 404 for both "doesn't exist" and "not yours". |
| **Scripted spamming of the endpoints** | Layered limits (see [Layered rate limits](#layered-rate-limits)), checked in Redis **before** any database work. Escalating blocks (see [Repeated requests and scripts](#repeated-requests-and-scripts)). |
| Farming many sessions at once | At most 3 open sessions per user. Starting is rate-limited. |
| Finishing faster than humanly possible | Minimum duration per action type. Violations are rejected and recorded as a risk signal. |
| Steady scripted farming within the limits | Hourly and daily points caps bound the damage. Behavioral detection flags the account (see [Suspicious activity: detection and response](#suspicious-activity-detection-and-response)). |
| Multiple accounts (Sybil) | Per-IP and per-device limits, a minimum account age to appear in the top 10, and multi-account risk signals. |
| Stolen access token | Short token lifetime (existing). Abnormal use shows up in risk signals. |
| Denial of service through SSE connections | Per-IP and per-instance connection limits. The edge (WAF / load balancer) limits by IP. |
| Insider or bug corrupting scores | Append-only ledger, reversals instead of edits, and totals that can be recomputed and reconciled. |

## Layered rate limits

Each request passes the cheapest checks first, so scripted traffic is rejected before it costs a database query:

| Layer | Key | Default | Enforced by |
|---|---|---|---|
| Edge | IP | 300 requests/min for all endpoints | WAF or load balancer |
| Start action | user | 30/min, burst 10 | Redis token bucket (Lua, atomic) |
| Start action | open sessions per user | 3 | PostgreSQL count, partial index |
| Complete action | user | 30/min, burst 10 | Redis token bucket |
| Complete action | IP | 120/min (shared networks, NAT) | Redis token bucket |
| Points | user | 600/hour, 3 000/day | In the transaction (see [The transaction](score-update.md#the-transaction)) |
| Stream | IP | 5 concurrent | Redis counter with TTL |

Limits are configured per action type where that makes sense (see [Configuration](operations.md#configuration)). Every rejection returns `Retry-After` and increments a violation counter.

## Repeated requests and scripts

How each repeat pattern is handled:

| Pattern | What happens | Database cost |
|---|---|---|
| Client retries a completion after a timeout | Stored response returned with `Idempotent-Replayed: true`. This is the normal, friendly path. | One primary-key read |
| Script resends a completed completion in a loop | Same stored response, until the token bucket rejects with 429 | None after the bucket empties |
| Script fires N parallel completions for one action | One wins; the others get the stored response | N short transactions, bounded by the bucket |
| Script loops start → wait for the minimum → complete | Each loop is legitimate-looking, but the points caps bound the gain. The regular timing is a strong risk signal (see [Suspicious activity: detection and response](#suspicious-activity-detection-and-response)). | Normal |
| Script keeps going after 429s | Escalation: **10 violations within 10 minutes → blocked for 15 minutes** (`403 temporarily_blocked`, checked in Redis only). A repeat offense doubles the block, up to 24 hours. Each block adds to the risk score. | None while blocked |

## What this design cannot guarantee

If the action runs entirely on the client, the server can't know whether a real person did it. A determined attacker can automate the real client and complete real actions at the fastest allowed pace. These controls make that **slow** (caps), **noticeable** (risk signals) and **reversible** (ledger reversals), but not impossible. Reviewers of this spec should not expect more.

The complete fix is to have the action's outcome **verified on the server**: the service that runs the action reports completion itself, and the client never asserts it ([Further improvements](../README.md#further-improvements), item 1).

## Suspicious activity: detection and response

**Detection.** The risk evaluator worker consumes score events and rejections and keeps per-user sliding windows in Redis. Each signal adds points to a risk score (weights are configurable; defaults shown):

| Signal | Example rule | Weight |
|---|---|---|
| Too-fast attempts | ≥ 3 `completion_too_fast` in 1 hour | 30 |
| Suspiciously regular timing | Standard deviation of the last 20 completion durations < 5% of their mean | 40 |
| Always at the minimum | > 80% of the last 20 completions within 10% of the minimum duration | 30 |
| Never stops | Completions in ≥ 20 of the last 24 hours | 30 |
| Repeated limit violations | Each temporary block | 20 |
| Multiple accounts | > 3 scoring accounts from one IP or device in 24 hours | 25 |
| Sudden jump | New account (< 7 days) reaches the top 50 | 20 |

**Response:**

| Risk score | Status | Effect |
|---|---|---|
| < 50 | `ok` | Normal |
| 50–99 | `under_review` | **Removed from the public leaderboard** (`ZREM`, triggering a republish) but keeps earning points and sees their own score. This doesn't tell the attacker what triggered it. The case goes to the review queue. |
| ≥ 100 | `suspended` | Completions return `403 temporarily_blocked` until a reviewer decides |

Reviewer outcomes:

- **Clear:** the user goes back to `ok`, `ZADD` restores them on the board, and their weights decay.
- **Confirm abuse:** reversal rows go into the ledger for the abusive events, the total is recomputed, and the sorted set is updated.

**Top-10 admission.** The top 10 is what attackers are after, so entering it has extra conditions:

- the account is older than 7 days;
- the email is verified;
- the risk score is below 25.

A user who meets the score but not the conditions is held back from the public board until they qualify. The default thresholds are product decisions (see [Open questions for product](../README.md#open-questions-for-product)).

## Other measures

- **Input validation:** every input is validated against the OpenAPI schemas, unknown fields are rejected, and bodies are size-limited.
- **No CSRF exposure:** authentication uses `Authorization` headers, not cookies. The stream is public and read-only, so `EventSource` doesn't need credentials.
- **Logging:** every rejection is logged with `userId`, IP, reason and request id. Tokens and other secrets are never logged.

## Implementation checklist: common mistakes

Real game and reward backends often get these wrong, and each one undoes the controls above. Code review for this module should check every item:

| Don't | Do |
|---|---|
| Read the user id from the body, query string or a socket message | Take identity **only** from the verified access token. Ignore and reject any `userId` field (unknown fields are a 400). |
| Accept a score, balance or points delta from the client, even "capped" | Accept only "start" and "complete". The server computes every number. |
| Treat a client-generated transaction id as protection | Client-generated idempotency keys stop *accidental* duplicates, not cheating, because an attacker just sends a new id each time. Only **server-issued**, owner-bound `actionId`s count. |
| Read the score, add to it in code, and write it back | One atomic statement (`SET score = score + $points`), with the row locked for the caps check |
| Ship a key in the client to "encrypt" or "sign" requests | Anything in the client can be extracted. Use TLS for transport and server-side state for authorization. |
| Add anti-abuse rules without tests or metrics | Every rule has an acceptance test (see [Acceptance criteria](delivery.md#acceptance-criteria)) and a counter (`abuse_rule_triggers_total{rule}`). **A rule that never fires in production is investigated:** a cap broken by a bug looks exactly like a cap nobody reaches. |
| Broadcast per-user data (balances, events) to all connected clients | Broadcast only the public top-10 snapshot. A user's own total is returned only to that user. |
| Cache the leaderboard for minutes or hours | Event-driven snapshots, with freshness measured (`leaderboard_propagation_seconds`) |
| Expire audit records after a while | The ledger is permanent and partitioned; corrections are new rows |
| Accept login or signed payloads without checking their age | Reject stale signed payloads (check `iat`/`auth_date` and a short window). This is part of the existing auth layer, but verify it. |
