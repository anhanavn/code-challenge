# ADR-0002: Live updates through two-level fan-out of full snapshots over SSE

**Status:** accepted

## Context

Every viewer must see top-10 changes within about a second. There are up to 20 000 viewers across several stateless API instances, and score changes can come from any instance.

## Decision

1. **Fan-out on write, in two levels.** When the top 10 changes, the outbox relay computes the new snapshot once and publishes it to one Redis pub/sub channel. Every API instance subscribes **once** and pushes the snapshot to the viewers connected to it.
2. **Each event is a full snapshot, not a delta.** At most 10 entries, under 1 KB, with a version that only increases. Clients replace their board with each one, so a missed message is harmless and messages arriving in the wrong order are dropped by version.
3. **Coalescing.** Each instance sends at most one event every 500 ms per viewer, always the latest state.
4. **Server-Sent Events** carry the stream. Score submissions stay on ordinary HTTP endpoints.

## Alternatives considered

| Alternative | Why not |
|---|---|
| Clients poll `GET /v1/leaderboard` every second | 20 000 requests/s, nearly all for an unchanged board, and up to 1 s of extra delay. It remains useful as a fallback for clients that can't use SSE: the same endpoint can be cached at a CDN. |
| WebSocket | Two-way and more capable, but the board only flows from server to client. WebSocket brings its own reconnection logic, proxy and load-balancer configuration, and authentication on upgrade, for no benefit here. If the product already uses WebSockets, the same snapshot event can be sent over them. |
| Submitting scores over the socket | Loses HTTP status codes, standard middleware (auth, rate limiting, validation) and safe retries. Writes are rare and request/response shaped, which HTTP handles well. |
| Sending deltas ("user X moved to rank 3") | Needs ordering, replay and gap detection. For 10 rows the full state is as small as a delta. |
| Redis Streams or Kafka for the broadcast | Durable delivery isn't needed: only the latest snapshot matters, and it's re-sent on reconnect. Pub/sub is simpler and enough. Durability is needed on the write path, which uses the PostgreSQL outbox. |
| Each instance computing the top 10 itself, on a timer | Repeats the same work N times per tick, adds latency up to the timer interval, and instances can briefly disagree. |

## Consequences

- Redis load grows with the number of instances, not viewers. Viewers cost one write per event on their instance.
- Infrastructure must keep SSE working: proxy buffering off, load balancer idle timeout above the 15-second heartbeat, HTTP/2.
- A viewer can be up to 500 ms behind (the coalescing window). This is within the 1-second target.
