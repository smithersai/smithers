#!/bin/sh
# The apps/mvp gate's steps in a gate machine's box (decision 0128; .smithers/flows/gate/flow.ts), run from the
# checkout's root as the job's user, never root:
#
#   gate.sh install            node_modules for this checkout: none to do when pnpm-lock.yaml is the image's
#   gate.sh fixtures           the suite's fixtures alone, for a run of some of its tests
#   gate.sh shard <i> <n>      the suite's fixtures as processes, then shard <i> of <n> (gate-shards.mjs); its blob report, with
#                              its coverage, goes to the run's artifacts as mvp-<i>-of-<n>.blob
#   gate.sh coverage <n>       the run's n blobs, merged by `vitest --merge-reports` under the suite's 100% thresholds
#
# The fixtures are the compose stack's (docker-compose.yml) without Docker: Postgres 17 with logical replication,
# PgBouncer in transaction mode, Electric 1.8.1. Everything lives under /tmp, the image's tmpfs.
set -eu
artifacts=http://artifacts.smithers.internal
root=$(pwd)
mvp=$root/apps/mvp
state=/tmp/gate
mkdir -p "$state"
stamp() { echo "gate: $1 $(date +%s)"; }

install() {
  if [ "$(sha256sum pnpm-lock.yaml | cut -d' ' -f1)" = "$(cat /etc/smithers-gate/lockfile.sha256 2>/dev/null)" ]; then
    stamp "install skipped: the image's lockfile"
  else
    pnpm install --frozen-lockfile --prefer-offline
    stamp "install done"
  fi
}

fixtures() {
  pg=/usr/lib/postgresql/17/bin data=$state/pg
  printf smithers >"$state/pw"
  "$pg/initdb" -D "$data" -U smithers --pwfile="$state/pw" -A scram-sha-256 >"$state/initdb.log" 2>&1
  "$pg/pg_ctl" -D "$data" -w -l "$state/postgres.log" -o "-p 54321 -c wal_level=logical -c max_connections=300 \
    -c listen_addresses=127.0.0.1 -c unix_socket_directories=$state" start >/dev/null
  PGPASSWORD=smithers "$pg/createdb" -h 127.0.0.1 -p 54321 -U smithers smithers
  cat >"$state/pgbouncer.ini" <<INI
[databases]
smithers = host=127.0.0.1 port=54321 dbname=smithers
[pgbouncer]
listen_addr = 127.0.0.1
listen_port = 54322
unix_socket_dir =
pidfile = $state/pgbouncer.pid
auth_type = scram-sha-256
auth_file = $state/userlist.txt
pool_mode = transaction
server_reset_query = RESET ALL
server_reset_query_always = 1
max_prepared_statements = 200
default_pool_size = 4
max_client_conn = 64
max_db_connections = 8
INI
  echo '"smithers" "smithers"' >"$state/userlist.txt"
  pgbouncer -d "$state/pgbouncer.ini" >"$state/pgbouncer.log" 2>&1
  mkdir -p "$state/electric"
  DATABASE_URL="postgresql://smithers:smithers@127.0.0.1:54321/smithers?sslmode=disable" ELECTRIC_INSECURE=true \
    ELECTRIC_PORT=30001 ELECTRIC_STORAGE_DIR="$state/electric" RELEASE_TMP="$state/electric" LANG=C.UTF-8 \
    setsid nohup /opt/electric/bin/entrypoint start >"$state/electric.log" 2>&1 </dev/null &
  tries=0
  until curl -fs -m 1 http://127.0.0.1:30001/v1/health >/dev/null; do
    tries=$((tries + 1)); [ $tries -lt 600 ] || { echo "gate: Electric didn't answer" >&2; exit 25; }; sleep 0.1
  done
  stamp "fixtures up"
}

suite() {
  cd "$mvp"
  # A container's exec passes only PATH: the image's own environment (Playwright's browsers, CI) is set here again.
  env CI=1 PLAYWRIGHT_BROWSERS_PATH=/opt/playwright TMPDIR=/tmp TEST_DATABASE_PORT=54321 TEST_ELECTRIC_PORT=30001 \
    DATABASE_URL=postgresql://smithers:smithers@127.0.0.1:54321/smithers ELECTRIC_URL=http://127.0.0.1:30001 \
    SMITHERS_TEST_PG_URL=postgresql://smithers:smithers@127.0.0.1:54321/smithers \
    SMITHERS_TEST_PGBOUNCER_URL=postgresql://smithers:smithers@127.0.0.1:54322/smithers MVP_TEST_STACK_PROJECT=gate \
    pnpm vitest run "$@"
}

case ${1:-} in
  install) install ;;
  fixtures) fixtures ;;
  shard)
    i=$2 n=$3 blob=$state/mvp-$2-of-$3.blob log=$state/mvp-$2-of-$3.log
    stamp "begin $(findmnt -n -o FSTYPE /tmp) $(nproc) cpus"
    fixtures
    # A shard's coverage is a part of the suite's: the thresholds apply where the parts merge (`coverage`). The step's
    # own output keeps only its head, so the whole log goes to the artifacts and the output says what failed.
    code=0
    # The shard's files, packed by their last times (gate-shards.mjs); paths hold no spaces.
    # shellcheck disable=SC2046
    suite $(node "$root/apps/mvp/ci/gate-shards.mjs" "$i" "$n") --reporter=default --reporter=blob --outputFile.blob="$blob" \
      --reporter=json --outputFile.json="$state/results.json" \
      --coverage.thresholds.lines=0 --coverage.thresholds.branches=0 \
      --coverage.thresholds.functions=0 --coverage.thresholds.statements=0 >"$log" 2>&1 || code=$?
    stamp "vitest exit $code"
    node "$root/apps/mvp/ci/gate-summary.mjs" results "$state/results.json" || tail -40 "$log"
    curl -fsS -m 300 -T "$log" "$artifacts/mvp-$i-of-$n.log"
    curl -fsS -m 300 -T "$blob" "$artifacts/mvp-$i-of-$n.blob"
    stamp "uploaded $(stat -c %s "$blob") bytes"
    exit $code
    ;;
  coverage)
    n=$2 blobs=$state/blobs
    mkdir -p "$blobs"
    i=1
    while [ $i -le "$n" ]; do
      curl -fsS -m 300 -o "$blobs/mvp-$i-of-$n.blob" "$artifacts/mvp-$i-of-$n.blob"
      i=$((i + 1))
    done
    stamp "blobs downloaded"
    code=0
    suite --merge-reports="$blobs" --reporter=dot --coverage.reportsDirectory="$state/coverage" \
      --coverage.reporter=json-summary --coverage.reporter=text-summary >"$state/coverage.log" 2>&1 || code=$?
    stamp "merge exit $code"
    node "$root/apps/mvp/ci/gate-summary.mjs" coverage "$state/coverage/coverage-summary.json" || true
    grep -E "Test Files|Tests |ERROR|threshold" "$state/coverage.log" | head -20
    curl -fsS -m 300 -T "$state/coverage.log" "$artifacts/mvp-coverage.log"
    exit $code
    ;;
  *) echo "usage: gate.sh install | fixtures | shard <i> <n> | coverage <n>" >&2; exit 2 ;;
esac
