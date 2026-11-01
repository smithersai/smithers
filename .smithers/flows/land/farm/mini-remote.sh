#!/bin/bash
# remote.sh <slot> <node version> <cwd> <e2e 0|1> <env count> [NAME=VALUE...] -- <command...>
set -uo pipefail
exec 9<&0 0</dev/null # fd 9 is the MacBook's keeper; nothing else reads it
SLOT=$1 NODE_VERSION=$2 CWD=$3 E2E=$4 NENV=$5; shift 5
# Slot names select database identifiers as well as paths: validate before either use.
case "$SLOT" in 1|2|3|4|5) ;; *) printf '[mini-run] invalid slot: %s\n' "$SLOT" >&2; exit 3 ;; esac
PASS=(); for ((i = 0; i < NENV; i++)); do PASS+=("$1"); shift; done
[ "$1" = "--" ] && shift
MIRROR=${MINI_FARM_ROOT:-$HOME/smithers-mirror}
FARM=$MIRROR/.farm
DIR=$MIRROR/slot$SLOT
NODE_BIN=$HOME/.nvm/versions/node/$NODE_VERSION/bin
say() { printf '[mini-run] %s\n' "$*" >&2; }
say "RUN_START pid=$$ slot=$SLOT"
# When the MacBook's side goes away, fd 9 reaches EOF: stop every process group this call started, and this script.
GROUPS_FILE=$FARM/slot$SLOT.groups ABORTED=$FARM/slot$SLOT.aborted MAIN=$$
mkdir -p "$FARM"; : >"$GROUPS_FILE"; rm -f "$ABORTED"
(
  while read -r _ <&9; do :; done
  touch "$ABORTED"
  for g in $(cat "$GROUPS_FILE"); do kill -TERM -- -"$g"; done
  kill -TERM "$MAIN"
) >/dev/null 2>&1 &
WATCHER=$!
disown "$WATCHER"
exec 9<&-
finish() {
  rc=$?
  trap - EXIT TERM INT HUP
  kill "$WATCHER" 2>/dev/null || :
  for group in $(cat "$GROUPS_FILE"); do kill -TERM -- -"$group" 2>/dev/null || :; done
  for _ in 1 2 3 4 5; do
    live=0
    for group in $(cat "$GROUPS_FILE"); do kill -0 -- -"$group" 2>/dev/null && live=1; done
    [ "$live" = 1 ] || break
    sleep 1
  done
  for group in $(cat "$GROUPS_FILE"); do kill -KILL -- -"$group" 2>/dev/null || :; done
  [ -z "${RUN_TMP:-}" ] || rm -rf -- "$RUN_TMP"
  exit "$rc"
}
trap finish EXIT
trap 'exit 143' TERM
trap 'exit 130' INT
trap 'exit 129' HUP
RUN_TMP=$(mktemp -d "$FARM/s$SLOT.XXXXXX") || exit 3
[ -x "$NODE_BIN/node" ] || { say "the mini has no node $NODE_VERSION: ssh $(hostname) and run 'nvm install ${NODE_VERSION#v}' then 'npm i -g pnpm'"; exit 3; }
CLEAN=(env -i HOME="$HOME" USER="$USER" LOGNAME="$USER" SHELL=/bin/bash TERM=dumb LANG=en_US.UTF-8 TMPDIR="$RUN_TMP"
  PATH="$NODE_BIN:$HOME/.bun/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin" "${PASS[@]+"${PASS[@]}"}" VITEST_MAX_WORKERS="${VITEST_MAX_WORKERS:-2}")
cd "$DIR" || exit 3
now() { perl -MTime::HiRes=time -e 'printf "%.1f", time'; }
dt() { perl -e 'printf "%.1f", $ARGV[1] - $ARGV[0]' "$1" "$2"; }

# Install when the lockfile, the workspace config or any package.json changed since this slot's last install.
hash=$( { echo "$NODE_VERSION"; cat pnpm-lock.yaml pnpm-workspace.yaml .npmrc .pnpmfile.mjs 2>/dev/null;
  find . \( -name node_modules -o -name dist -o -name .alchemy -o -name target -o -name test-results -o -name .wrangler \) -prune \
    -o -name package.json -type f -print | LC_ALL=C sort | while read -r f; do echo "$f"; cat "$f"; done
} | shasum -a 256 | cut -c1-64)
stamp=$FARM/slot$SLOT.install
if [ "$(cat "$stamp" 2>/dev/null)" != "$hash" ]; then
# pnpm's optimistic repeat install answers "Already up to date" from mtimes, which rsync preserves, and links nothing new.
  t=$(now); say "slot $SLOT: dependencies changed; pnpm install --frozen-lockfile --prefer-offline"
  if ! "${CLEAN[@]}" pnpm install --frozen-lockfile --prefer-offline --config.optimistic-repeat-install=false --reporter=append-only >"$FARM/slot$SLOT.install.log" 2>&1; then
    tail -40 "$FARM/slot$SLOT.install.log" >&2; say "install failed; full log on the mini at $FARM/slot$SLOT.install.log"; exit 4
  fi
  echo "$hash" >"$stamp"; say "slot $SLOT: installed in $(dt "$t" "$(now)") s"
fi

SERVICES=$E2E
case "$CWD" in apps/mvp|apps/mvp/*|packages/effect-electric|packages/smithers/flows/database|packages/smithers) SERVICES=1;; esac
for setting in "${PASS[@]+"${PASS[@]}"}"; do
  case "$setting" in MINI_RUN_SERVICES=0) SERVICES=0;; MINI_RUN_SERVICES=1) SERVICES=1;; esac
done
# The existing cluster stays at the app test harness's allowed localhost:54321.
# Each slot gets a separate database; its Durable Objects must never share run tables.
up() { nc -z 127.0.0.1 54321 && nc -z 127.0.0.1 54322 && nc -z 127.0.0.1 30001; } 2>/dev/null
if [ "$SERVICES" = 1 ] && ! up; then
  say "starting the compose Postgres, PgBouncer and Electric"
  lockf -t 300 "$FARM/compose.lock" "${CLEAN[@]}" docker compose -f "$DIR/apps/mvp/docker-compose.yml" up -d --wait \
    >"$FARM/compose.log" 2>&1 || { tail -20 "$FARM/compose.log" >&2; say "docker compose up failed"; exit 5; }
fi
# Unit/integration harnesses use the existing shared scratch-schema services.
# Only local e2e dev servers use a slot-private, fresh app/engine store.
if [ "$E2E" = 1 ]; then
  DATABASE_NAME=smithers_farm_slot$SLOT
  POOL_PORT=$((55400 + SLOT))
  ELECTRIC_PORT=$((30100 + SLOT))
  # psql's conditional CREATE is idempotent; the caller already holds this slot's lock.
  "${CLEAN[@]}" docker compose -f "$DIR/apps/mvp/docker-compose.yml" exec -T postgres \
    psql -X -U smithers -d smithers -v ON_ERROR_STOP=1 \
    >"$FARM/slot$SLOT.database.log" 2>&1 <<SQL
SELECT 'CREATE DATABASE $DATABASE_NAME OWNER smithers'
WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = '$DATABASE_NAME')\gexec
SQL
  if [ $? != 0 ]; then
    tail -20 "$FARM/slot$SLOT.database.log" >&2; say "slot $SLOT: database setup failed"; exit 5
  fi
  # These follow PASS deliberately: callers cannot reconnect a slot to shared run state.
  CLEAN+=(DATABASE_URL="postgresql://smithers:smithers@localhost:54321/$DATABASE_NAME"
    ELECTRIC_URL="http://127.0.0.1:$ELECTRIC_PORT" TEST_ELECTRIC_PORT="$ELECTRIC_PORT"
    SMITHERS_TEST_PG_URL="postgresql://smithers:smithers@localhost:54321/$DATABASE_NAME"
    SMITHERS_TEST_PGBOUNCER_URL="postgresql://smithers:smithers@127.0.0.1:$POOL_PORT/$DATABASE_NAME"
    FARM_SLOT="$SLOT" FARM_POOL_PORT="$POOL_PORT" FARM_ELECTRIC_PORT="$ELECTRIC_PORT")
  # A dev-server restart loses its shell processes. Keep the test's app records,
  # engine records and local objects on the same fresh lifetime, under the slot lock.
  say "slot $SLOT: resetting only its database and local Durable Object state"
  "${CLEAN[@]}" docker compose -p "smithers-farm-slot$SLOT" -f "$FARM/compose.slot.yml" down \
    >"$FARM/slot$SLOT.reset.log" 2>&1 || {
      tail -20 "$FARM/slot$SLOT.reset.log" >&2; say "slot $SLOT: stopping its database consumers failed"; exit 5;
    }
  "${CLEAN[@]}" docker compose -f "$DIR/apps/mvp/docker-compose.yml" exec -T postgres \
    psql -X -U smithers -d postgres -v ON_ERROR_STOP=1 \
    >>"$FARM/slot$SLOT.reset.log" 2>&1 <<SQL
SELECT pg_drop_replication_slot(slot_name) FROM pg_replication_slots
WHERE slot_name = 'electric_slot_farm_slot$SLOT';
DROP DATABASE IF EXISTS $DATABASE_NAME WITH (FORCE);
CREATE DATABASE $DATABASE_NAME OWNER smithers;
SQL
  if [ $? != 0 ]; then
    tail -20 "$FARM/slot$SLOT.reset.log" >&2; say "slot $SLOT: database reset failed"; exit 5
  fi
  rm -rf "$DIR/apps/mvp/.alchemy/local" || { say "slot $SLOT: local state reset failed"; exit 5; }
  say "slot $SLOT: checking its isolated database, PgBouncer and Electric"
  "${CLEAN[@]}" docker compose -p "smithers-farm-slot$SLOT" -f "$FARM/compose.slot.yml" up -d --wait \
    >"$FARM/slot$SLOT.compose.log" 2>&1 || {
      tail -20 "$FARM/slot$SLOT.compose.log" >&2; say "slot $SLOT: docker compose up failed"; exit 5;
    }
fi

media=$HOME/Desktop/smithers-mvp
mkdir -p "$media/gifs" "$media/videos"
marker=$FARM/slot$SLOT.marker; touch "$marker"; sleep 1
if [ "$E2E" = 1 ]; then
  # Never reuse another workspace's server. The HTTPS front follows whichever
  # HTTP port Alchemy/Vite selected; Playwright targets only this slot's front.
  HTTPS_PORT=$((14430 + SLOT))
  BASE_URL="https://localhost:$HTTPS_PORT"
  if nc -z localhost "$HTTPS_PORT" 2>/dev/null; then
    say "slot $SLOT: HTTPS port $HTTPS_PORT is already in use; refusing to reuse a server"; exit 7
  fi
  CLEAN+=(DEV_HTTPS_PORT="$HTTPS_PORT" BASE_URL="$BASE_URL")
  # alchemy dev refuses to plan without the chat model's credential. The mini has none: point every model role at a
  # closed local port, so the dev server starts and a spec that calls the model fails fast instead of spending.
  CLEAN+=(CHAT_MODEL='{"protocol":"openai-chat","baseUrl":"http://127.0.0.1:9","modelId":"no-model-on-the-mini","credential":"MINI_FARM_NO_MODEL"}'
    SMITHERS_MODEL_KEY_MINI_FARM_NO_MODEL=none SMITHERS_MODEL_KEY_MINI_FARM_NO_MODEL_ORIGIN=http://127.0.0.1:9)
  (cd apps/mvp && "${CLEAN[@]}" pnpm -s db:migrate >"$FARM/slot$SLOT.migrate.log" 2>&1) || { cat "$FARM/slot$SLOT.migrate.log" >&2; say "db:migrate failed"; exit 6; }
  # The dev server, started here rather than by Playwright: Playwright waits only for the site, and ChatApi answers
  # about 30 s later on the mini, so the first specs would see 503s. Playwright reuses this server.
  t=$(now)
  set -m
  (cd apps/mvp && exec "${CLEAN[@]}" pnpm dev) >"$FARM/slot$SLOT.dev.log" 2>&1 &
  DEV=$!
  set +m
  echo "$DEV" >>"$GROUPS_FILE"
  ready=0
  for _ in $(seq 1 180); do
    kill -0 "$DEV" 2>/dev/null || break
    code=$(curl -k -s -o /dev/null -m 2 -w '%{http_code}' "$BASE_URL/api/auth/session" || true)
    case $code in 000|503) sleep 1 ;; *) ready=1; break ;; esac
  done
  if [ $ready != 1 ]; then
    tail -30 "$FARM/slot$SLOT.dev.log" >&2; say "the dev server did not answer /api/auth/session; log on the mini at $FARM/slot$SLOT.dev.log"
    kill -TERM -- -"$DEV" 2>/dev/null; exit 7
  fi
  say "slot $SLOT: dev server ready at $BASE_URL in $(dt "$t" "$(now)") s"
fi

cd "$DIR/$CWD" || exit 3
# The reservation proved no previous command group is live; these are slot scratch outputs.
rm -rf -- test-results playwright-report
# The command gets its own process group, which the watcher stops if the MacBook's side goes away.
set -m
"${CLEAN[@]}" "$@" &
pid=$!
set +m
echo "$pid" >>"$GROUPS_FILE"
wait "$pid"; rc=$?
[ -e "$ABORTED" ] && exit "$rc" # the watcher is stopping everything
kill "$WATCHER" 2>/dev/null
if [ -n "${DEV:-}" ]; then
  kill -TERM -- -"$DEV" 2>/dev/null
  for _ in 1 2 3 4 5 6 7 8 9 10; do kill -0 "$DEV" 2>/dev/null || break; sleep 1; done
  kill -KILL -- -"$DEV" 2>/dev/null
fi
# Media and test results this run wrote, for the MacBook to fetch.
(cd "$media" && find gifs videos -type f -newer "$marker" 2>/dev/null) >"$FARM/slot$SLOT.media"
if [ -d test-results ] && [ -n "$(find test-results -newer "$marker" -print -quit 2>/dev/null)" ]; then
  echo "$HOME/smithers-mirror/slot$SLOT/$CWD/test-results" >"$FARM/slot$SLOT.results"
else
  : >"$FARM/slot$SLOT.results"
fi
exit "$rc"
