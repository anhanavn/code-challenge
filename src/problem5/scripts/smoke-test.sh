#!/usr/bin/env bash
# End-to-end check against a running stack: health, create, read, conditional update, filter, delete.
# Usage: BASE_URL=http://localhost:3000 [API_KEY=...] ./scripts/smoke-test.sh
set -euo pipefail

BASE_URL="${BASE_URL:-http://localhost:3000}"
TASKS="$BASE_URL/api/v1/tasks"
AUTH=()
if [[ -n "${API_KEY:-}" ]]; then AUTH=(-H "Authorization: Bearer $API_KEY"); fi

fail() { echo "✗ $*" >&2; exit 1; }
status() { curl -s -o /dev/null -w '%{http_code}' ${AUTH[@]+"${AUTH[@]}"} "$@"; }

echo "Waiting for $BASE_URL/health ..."
for attempt in $(seq 1 30); do
  curl -fsS "$BASE_URL/health" >/dev/null 2>&1 && break
  [[ $attempt == 30 ]] && fail "API did not become healthy"
  sleep 1
done

created=$(curl -fsS ${AUTH[@]+"${AUTH[@]}"} -X POST "$TASKS" -H 'Content-Type: application/json' \
  -d '{"title":"Smoke test","priority":"high"}') || fail "create failed"
id=$(node -pe 'JSON.parse(process.argv[1]).id' "$created")
echo "✓ created $id"

[[ $(status "$TASKS/$id") == 200 ]] || fail "get failed"
echo "✓ read"

[[ $(status -X PATCH "$TASKS/$id" -H 'Content-Type: application/json' -H 'If-Match: "1"' -d '{"status":"done"}') == 200 ]] \
  || fail "conditional update failed"
[[ $(status -X PATCH "$TASKS/$id" -H 'Content-Type: application/json' -H 'If-Match: "1"' -d '{"status":"todo"}') == 412 ]] \
  || fail "stale If-Match was not rejected"
echo "✓ optimistic locking"

curl -fsS ${AUTH[@]+"${AUTH[@]}"} "$TASKS?status=done&priority=high" | grep -q "$id" || fail "filter did not return the task"
echo "✓ filtering"

[[ $(status -X DELETE "$TASKS/$id") == 204 ]] || fail "delete failed"
[[ $(status "$TASKS/$id") == 404 ]] || fail "task still exists after delete"
echo "✓ delete"

echo "Smoke test passed"
