# ADR-0001: Server-authoritative scoring with single-use action sessions

**Status:** accepted

## Context

Completing an action raises the user's score, and the client reports the completion. Anything the client sends can be forged, replayed or scripted. The module must stop users from raising scores they haven't earned.

## Decision

1. **No endpoint accepts points or scores.** The client says "start action of type T", then "complete action A". The points come from the server-side `action_types` configuration.
2. **Starting an action creates a server-side session** that is bound to the user, has an expiry time, and can be completed **once**. The single use is enforced by a conditional `UPDATE … WHERE status = 'started'` inside the scoring transaction, with `UNIQUE (action_id)` on the ledger as a second guarantee.
3. **Completing is idempotent.** A repeated completion returns the stored original response and awards nothing. Honest retries after a timeout are safe, and replays are worthless.
4. **Plausibility and limits are enforced on the server:** a minimum duration per action type, at most 3 open sessions per user, rate limits, and hourly and daily points caps.

## Alternatives considered

| Alternative | Why not |
|---|---|
| Client sends `{ "points": 10 }` or a new score | Trivially forged. This is the vulnerability the requirement describes. |
| A signed action token (JWT or HMAC) given out at start and sent back at completion | It adds no protection here. Single use still needs server state (a used-token list or the session row), and that state alone already gives ownership, expiry and single use. The signature would only duplicate those checks. Signing becomes useful when a *different* service verifies completion without database access (see the [Further improvements](../../README.md#further-improvements), item 1). |
| Signing the request on the client (an HMAC key shipped in the app) | Any key shipped to the client can be extracted from it. This is security through obscurity. |
| A plain `POST /score/increment` protected only by a rate limit | No single-use guarantee or plausibility check. A script can farm points at the maximum rate forever. |

## Consequences

- One indexed row per action session. Sessions older than 30 days are deleted.
- Two calls per action (start and complete) instead of one. This is what makes timing checks and single use possible.
- This does **not** prove that a person performed the action. A scripted real client can still complete real actions within the limits. That remaining risk is handled by caps and behavioral detection ([Suspicious activity: detection and response](../security.md#suspicious-activity-detection-and-response)). It is fully removed only by having the action verified on a server ([Further improvements](../../README.md#further-improvements)).
