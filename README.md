# 99Tech Code Challenge

Solutions to problems 4, 5 and 6. Each problem is self-contained in its own folder, with its own README, tests and tooling.

| Problem | What it is | Verify it |
|---|---|---|
| [**4. Three ways to sum to n**](src/problem4/) | Three TypeScript implementations with complexity analysis | 35 tests (including property-based tests against a BigInt reference) + benchmark |
| [**5. A Crude Server**](src/problem5/) | CRUD Tasks API: Express 5, TypeScript, Drizzle ORM, PostgreSQL | 71 integration tests on real PostgreSQL, Docker smoke test, CI/CD |
| [**6. Architecture**](src/problem6/) | Specification of a live top-10 scoreboard module with anti-cheat | OpenAPI contract and diagrams validated in CI |

## Highlights

**Problem 4.** Input can be "any integer", so negative numbers are handled, and inputs outside the safe range are rejected rather than silently returning wrong numbers. The third implementation is a divide-and-conquer recursion: plain recursion overflows the stack at n = 10 000, this one stays about 27 frames deep. The README shows why `n(n+1)/2` stays exact even though the intermediate product exceeds `MAX_SAFE_INTEGER`, and the tests check it.

**Problem 5.** Beyond the required CRUD and filters:

- safe concurrent edits (`ETag` / `If-Match` → 412);
- safe retries (`Idempotency-Key`, claimed atomically, so it holds across instances);
- cursor pagination that never skips or repeats rows;
- RFC 9457 errors, validation at every boundary;
- rate limiting, optional API-key auth, graceful shutdown;
- OpenAPI docs at `/docs`;
- a one-command Docker stack (PostgreSQL → migrations → API).

**Problem 6.** The client never sends a score. The server issues single-use, user-bound action sessions and decides the points itself. The README maps each requirement to the design and each attack to the mechanism that blocks it. It also says plainly what client-side actions can't guarantee. Fan-out over SSE, an outbox for reliability, resilience patterns and a 100 → 1 000 → 1 M scaling path are documented in `docs/`.

## Running

Requirements: **Node.js 20+**. **Docker** is needed for problem 5 only.

```bash
# Problem 4
cd src/problem4 && npm install && npm test

# Problem 5: the whole stack
cd src/problem5 && docker compose up --build      # API on http://localhost:3000, docs at /docs
# or the tests (they need PostgreSQL)
cd src/problem5 && npm install && npm run db:up && npm test

# Problem 6
cd src/problem6 && npm install && npm test
```

Each problem's README covers configuration, design decisions and assumptions in detail.

## Notes

- **Assumptions** are stated in each problem's README, where the task left room for interpretation: negative `n` in problem 4, the resource and auth model in problem 5, scale targets and product questions in problem 6.
- **CI/CD** workflows for problems 5 and 6 live in their own folders (`src/problem5/.github/`, `src/problem6/.github/`), so each problem works as a standalone repository. GitHub only runs workflows from the repository root's `.github/workflows/`, so in this combined repository they document the pipeline rather than run it.
