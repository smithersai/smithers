#!/usr/bin/env bash
# Real Compose regression: use distinct listeners/catalogs and reclaim this run after a failing command.
set -euo pipefail
app_directory=$(cd "$(dirname "$0")/.." && pwd)
receipt=$(mktemp)
trap 'rm -f "$receipt"' EXIT
export MVP_STACK_TEST_RECEIPT="$receipt"
set +e
bash "$app_directory/db/test-stack.sh" -- bash -c '
  set -eu
  node --input-type=module -e '\''
    import assert from "node:assert/strict"
    const database = new URL(process.env.DATABASE_URL)
    assert.equal(database.hostname, "127.0.0.1")
    assert.notEqual(database.port, "54321")
    assert.notEqual(new URL(process.env.ELECTRIC_URL).port, "30001")
  '\''
  count=$(docker compose -p "$MVP_TEST_STACK_PROJECT" exec -T postgres psql -XAt -U smithers -d smithers -c "SELECT count(*) FROM pg_namespace WHERE nspname NOT LIKE '\''pg_%'\'' AND nspname NOT IN ('\''public'\'', '\''information_schema'\'')")
  test "$count" = 0
  printf "%s\n" "$MVP_TEST_STACK_PROJECT" > "$MVP_STACK_TEST_RECEIPT"
  exit 17
'
result=$?
set -e
test "$result" = 17
project=$(cat "$receipt")
test -n "$project"
test -z "$(docker ps -aq --filter "label=com.docker.compose.project=$project")"
test -z "$(docker volume ls -q --filter "label=com.docker.compose.project=$project")"
printf 'Isolated listeners, fresh catalog and failure cleanup passed\n'
