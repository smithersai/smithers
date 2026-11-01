#!/usr/bin/env bash
# Private service lifetime for one reserved invocation, in a stable farm-owned Podman runtime.
set -euo pipefail
slot=${1:?slot required}
action=${2:-start}
[[ "$slot" =~ ^[1-9][0-9]*$ ]] && [ "$slot" -le 64 ] || exit 2
run=${FARM_RUN_ID:?invoking run identity required}
[[ "$run" =~ ^[a-zA-Z0-9_-]+$ ]] || exit 2
FARM=$HOME/lat-mirror/.farm
export XDG_RUNTIME_DIR=$FARM/podman-v2/xdg
mkdir -p "$XDG_RUNTIME_DIR" "$FARM/podman-v2/run" "$FARM/podman-v2/storage"
chmod 700 "$XDG_RUNTIME_DIR"
engine() { command podman --root "$FARM/podman-v2/storage" --runroot "$FARM/podman-v2/run" "$@"; }
prefix=lat-slot${slot}-v2-$run
if [ "$action" = stop ]; then
  for service in electric pgbouncer postgres; do
    name=$prefix-$service
    owner=$(engine inspect -f '{{index .Config.Labels "smithers.farm.run"}}' "$name" 2>/dev/null || true)
    if [ "$owner" = "$run" ]; then engine rm -f "$name" >/dev/null; fi
  done
  # This volume name is unique to the invoking run; never prune a shared store.
  engine volume rm "$prefix-postgres" >/dev/null 2>&1 || true
  exit 0
fi
[ "$action" = start ] || { echo '[lat-run] invalid service action' >&2; exit 2; }
command -v podman >/dev/null || { echo '[lat-run] PODMAN_MISSING: install rootless Podman on this host' >&2; exit 5; }
# timeout cannot invoke a shell function: bound the real binary preflight directly.
timeout 20 podman --root "$FARM/podman-v2/storage" --runroot "$FARM/podman-v2/run" info >/dev/null || {
  echo '[lat-run] PODMAN_RUNTIME_UNAVAILABLE in stable private farm runtime; no reset or process reap attempted' >&2; exit 5;
}
start() { local name=$1; shift; engine run -d --name "$name" --label "smithers.farm.run=$run" "$@" >/dev/null; }
start "$prefix-postgres" --network slirp4netns -e POSTGRES_USER=smithers -e POSTGRES_PASSWORD=smithers -e POSTGRES_DB=smithers -v "$prefix-postgres:/var/lib/postgresql/data" docker.io/library/postgres:17.11-alpine postgres -p 54321 -c wal_level=logical -c max_connections=100
pid=$(engine inspect -f '{{.State.Pid}}' "$prefix-postgres")
if ! engine unshare nsenter --net="/proc/$pid/ns/net" -- true; then
  echo '[lat-run] NAMESPACE_UNAVAILABLE: container and client runtime ownership differ; stable XDG_RUNTIME_DIR/runroot required; no retry attempted' >&2
  exit 5
fi
ready=0
for ((i=0;i<60;i++)); do
  if engine exec "$prefix-postgres" pg_isready -p 54321 -U smithers -d smithers >/dev/null 2>&1; then ready=1; break; fi
  sleep 1
done
[ "$ready" = 1 ] || { echo '[lat-run] POSTGRES_NOT_READY after 60s' >&2; exit 5; }
start "$prefix-electric" --network "container:$prefix-postgres" -e DATABASE_URL=postgresql://smithers:smithers@127.0.0.1:54321/smithers?sslmode=disable -e ELECTRIC_PORT=30001 -e ELECTRIC_INSECURE=true docker.io/electricsql/electric:1.8.1
start "$prefix-pgbouncer" --network "container:$prefix-postgres" -e DATABASE_URL=postgres://smithers:smithers@127.0.0.1:54321/smithers -e LISTEN_PORT=54322 -e POOL_MODE=transaction -e SERVER_RESET_QUERY='RESET ALL' -e SERVER_RESET_QUERY_ALWAYS=1 -e AUTH_TYPE=scram-sha-256 -e MAX_PREPARED_STATEMENTS=200 -e DEFAULT_POOL_SIZE=4 -e MAX_DB_CONNECTIONS=8 -e MAX_CLIENT_CONN=64 docker.io/edoburu/pgbouncer:v1.25.2-p0@sha256:7d7a27d9e90985cab5cf42256f5c13a3120baa4b055b69df37beb272b89b2340
for ((i=0;i<90;i++)); do
  if engine unshare nsenter --net="/proc/$pid/ns/net" -- curl -fsS --max-time 2 http://127.0.0.1:30001/v1/health >/dev/null 2>&1 && engine exec "$prefix-pgbouncer" pg_isready -h 127.0.0.1 -p 54322 -U smithers -d smithers >/dev/null 2>&1; then
    printf '%s\n' "$pid" >"$FARM/slot$slot.netpid"
    echo '[lat-run] isolated integration services ready' >&2
    exit 0
  fi
  sleep 1
done
echo '[lat-run] INTEGRATION_NOT_READY after 90s' >&2
exit 5
