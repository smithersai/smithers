#!/usr/bin/env bash
# A CLI test boundary: own the real dependencies for the command, including failure and cancellation.
set -euo pipefail
app_directory=$(cd "$(dirname "$0")/.." && pwd)
fixture_project="mvp-test-$(node -e 'process.stdout.write(require("node:crypto").randomUUID())')"
compose=(docker compose -p "$fixture_project" -f "$app_directory/docker-compose.yml" -f "$app_directory/docker-compose.test.yml")
# Free loopback ports, from the kernel. Left to choose (`127.0.0.1::5432`), Docker takes the next port of the ephemeral
# range it hasn't handed out itself, without asking whether a socket already holds it, and fails the start with
# "bind: address already in use" rather than trying another: on a host with many open connections that happens often.
read -r postgres_port electric_port pool_port < <(node --input-type=module -e '
import { createServer } from "node:net"
const servers = await Promise.all([0, 1, 2].map(() => new Promise((resolve) => {
  const server = createServer()
  server.listen(0, "127.0.0.1", () => resolve(server))
})))
process.stdout.write(servers.map((server) => server.address().port).join(" ") + "\n")
await Promise.all(servers.map((server) => new Promise((resolve) => server.close(resolve))))
')
export MVP_TEST_POSTGRES_BIND="127.0.0.1:$postgres_port" MVP_TEST_ELECTRIC_BIND="127.0.0.1:$electric_port" \
  MVP_TEST_POOL_BIND="127.0.0.1:$pool_port"
export MVP_TEST_MAX_CONNECTIONS=100 MVP_TEST_POOL_MAX_CLIENTS=64 MVP_TEST_POOL_MAX_DATABASE_CONNECTIONS=8
# Leave time for cleanup before a caller escalates termination of this owned process group.
cleanup() { "${compose[@]}" down --timeout 1 --volumes --remove-orphans >/dev/null; }
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
"${compose[@]}" up -d --wait --wait-timeout 60
published_port() { "${compose[@]}" port "$1" "$2" | awk -F: '{print $NF}'; }
database_port=$(published_port postgres 5432)
electric_port=$(published_port electric 3000)
pool_port=$(published_port pgbouncer 5432)
for port in "$database_port" "$electric_port" "$pool_port"; do [[ "$port" =~ ^[0-9]+$ ]] || exit 1; done
# This stack replaces a farm slot's database, pool and Electric for the command; fixtures must not mix the two.
unset FARM_SLOT FARM_ELECTRIC_PORT FARM_POOL_PORT
export TEST_DATABASE_PORT="$database_port" TEST_ELECTRIC_PORT="$electric_port"
export DATABASE_URL="postgresql://smithers:smithers@127.0.0.1:$TEST_DATABASE_PORT/smithers"
export ELECTRIC_URL="http://127.0.0.1:$TEST_ELECTRIC_PORT"
export SMITHERS_TEST_PG_URL="$DATABASE_URL"
export SMITHERS_TEST_PGBOUNCER_URL="postgresql://smithers:smithers@127.0.0.1:$pool_port/smithers"
export MVP_TEST_STACK_PROJECT="$fixture_project"
# Compose waits for PostgreSQL and PgBouncer health. Electric's readiness is its real HTTP health signal.
node --input-type=module <<'JS'
import { setTimeout } from "node:timers/promises"
const deadline = Date.now() + 30_000
while (Date.now() < deadline) {
  const response = await fetch(`${process.env.ELECTRIC_URL}/v1/health`, { signal: AbortSignal.timeout(1_000) }).catch(() => undefined)
  if (response?.ok) process.exit(0)
  await setTimeout(100)
}
throw new Error("The isolated Electric fixture did not become healthy")
JS
if [ "${1:-}" = -- ]; then shift; fi
if [ "$#" = 0 ]; then set -- pnpm vitest run; fi
"$@"
