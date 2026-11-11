#!/usr/bin/env bash
# Real Compose regression: use distinct listeners/catalogs and reclaim this run after a failing command.
set -euo pipefail
app_directory=$(cd "$(dirname "$0")/.." && pwd)
cd "$app_directory"
node --test db/test-stack.compose.test.mjs
receipt=$(mktemp)
trap 'rm -f "$receipt"' EXIT
export MVP_STACK_TEST_RECEIPT="$receipt"
# Inside a farm slot the owned stack still wins: no slot endpoint reaches the command.
export FARM_SLOT=9 FARM_ELECTRIC_PORT=1 FARM_POOL_PORT=1
set +e
bash "$app_directory/db/test-stack.sh" -- bash -c '
  set -eu
  node --input-type=module -e '\''
    import assert from "node:assert/strict"
    const database = new URL(process.env.DATABASE_URL)
    assert.equal(database.hostname, "127.0.0.1")
    assert.equal(database.port, process.env.TEST_DATABASE_PORT)
    assert.equal(new URL(process.env.ELECTRIC_URL).port, process.env.TEST_ELECTRIC_PORT)
    assert.equal(process.env.FARM_SLOT, undefined)
    assert.equal(process.env.FARM_ELECTRIC_PORT, undefined)
    assert.equal(process.env.FARM_POOL_PORT, undefined)
  '\''
  count=$(docker compose -p "$MVP_TEST_STACK_PROJECT" exec -T postgres psql -XAt -U smithers -d smithers -c "SELECT count(*) FROM pg_namespace WHERE nspname NOT LIKE '\''pg_%'\'' AND nspname NOT IN ('\''public'\'', '\''information_schema'\'')")
  test "$count" = 0
  # Shared disk flush stalls must not consume engine leases or test deadlines. Durability settings stay on.
  container=$(docker compose -p "$MVP_TEST_STACK_PROJECT" ps -q postgres)
  test "$(docker inspect --format '\''{{range .Mounts}}{{if eq .Destination "/var/lib/postgresql/data"}}{{.Type}}{{end}}{{end}}'\'' "$container")" = tmpfs
  test "$(docker compose -p "$MVP_TEST_STACK_PROJECT" exec -T postgres psql -XAt -U smithers -d smithers -c "SHOW fsync; SHOW synchronous_commit")" = "$(printf '\''on\non'\'')"
  export MVP_STACK_OUTER_PROJECT="$MVP_TEST_STACK_PROJECT"
  export MVP_STACK_OUTER_DATABASE_PORT="$TEST_DATABASE_PORT"
  export MVP_STACK_OUTER_ELECTRIC_PORT="$TEST_ELECTRIC_PORT"
  # A second live fixture cannot share the first fixtures listeners or owned resources.
  bash db/test-stack.sh -- node --input-type=module -e '\''
    import assert from "node:assert/strict"
    assert.notEqual(process.env.MVP_TEST_STACK_PROJECT, process.env.MVP_STACK_OUTER_PROJECT)
    assert.notEqual(process.env.TEST_DATABASE_PORT, process.env.MVP_STACK_OUTER_DATABASE_PORT)
    assert.notEqual(process.env.TEST_ELECTRIC_PORT, process.env.MVP_STACK_OUTER_ELECTRIC_PORT)
  '\''
  # The inner cleanup left the outer database available.
  test "$(docker compose -p "$MVP_TEST_STACK_PROJECT" exec -T postgres psql -XAt -U smithers -d smithers -c "SELECT 1")" = 1
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
node db/test-stack.cancel.test.mjs
