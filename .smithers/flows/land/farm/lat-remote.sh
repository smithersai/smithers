#!/bin/bash
# remote.sh <slot> <node version> <cwd> <e2e 0|1> <env count> [NAME=VALUE...] -- <command...>
set -uo pipefail
exec 9<&0 0</dev/null # fd 9 is the MacBook's keeper; nothing else reads it
SLOT=$1 NODE_VERSION=$2 CWD=$3 NENV=$5; shift 5
PASS=(); for ((i = 0; i < NENV; i++)); do PASS+=("$1"); shift; done
[ "$1" = "--" ] && shift
FARM=$HOME/lat-mirror/.farm
# Podman runtime state must outlive per-test TMPDIR and share one user namespace.
export XDG_RUNTIME_DIR=$FARM/podman-v2/xdg
FARM_RUN_ID=s$SLOT-$$
SERVICES_STARTED=0
mkdir -p "$XDG_RUNTIME_DIR" "$FARM/podman-v2/run" "$FARM/podman-v2/storage"
chmod 700 "$XDG_RUNTIME_DIR"
DIR=$HOME/lat-mirror/slot$SLOT
source "$HOME/lanes/env.sh" >/dev/null 2>&1
NODE_BIN=$(dirname "$(command -v node)")
NODE_VERSION=$("$NODE_BIN/node" -v)
say() { printf '[lat-run] %s\n' "$*" >&2; }
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
  trap - EXIT TERM INT
  if [ -n "${workspace_backup:-}" ]; then cp "$workspace_backup" "$DIR/pnpm-workspace.yaml"; rm -f "$workspace_backup"; fi
  kill "$WATCHER" 2>/dev/null || true
  while read -r group; do
    if kill -0 -- -"$group" 2>/dev/null; then
      kill -TERM -- -"$group" 2>/dev/null || true
      sleep 2
      kill -KILL -- -"$group" 2>/dev/null || true
    fi
  done <"$GROUPS_FILE"
  if [ -n "${CLI_PGDATA:-}" ]; then
    "$PG_SERVER_BIN/pg_ctl" -D "$CLI_PGDATA" -m immediate -w stop >"$FARM/slot$SLOT.cli-postgres-stop.log" 2>&1 || true
  fi
  if [ "$SERVICES_STARTED" = 1 ]; then
    FARM_RUN_ID="$FARM_RUN_ID" bash "$FARM/services-slot$SLOT.sh" "$SLOT" stop || say "service cleanup failed for own run $FARM_RUN_ID"
    rm -f "$FARM/slot$SLOT.netpid"
  fi
  [ -z "${RUN_TMP:-}" ] || rm -rf -- "$RUN_TMP"
}
trap finish EXIT
trap 'exit 143' TERM
trap 'exit 130' INT
# Keep temp names short (Postgres Unix sockets), private and outside rsync's tree.
# CLI fixtures walk ancestors looking for project/legacy state. A temp root
# under lane's home inherits that account's .smithers; isolate CLI projects
# outside the home without touching any shared /tmp directory.
case "$CWD" in
  packages/smithers) RUN_TMP=$(mktemp -d "/tmp/smithers-cli-s$SLOT.XXXXXX") || exit 4 ;;
  *) RUN_TMP=$(mktemp -d "$FARM/s$SLOT.XXXXXX") || exit 4 ;;
esac
# PostgreSQL matrices own their server; Debian does not expose server tools on PATH.
PG_SERVER_BIN=/usr/lib/postgresql/18/bin
if [ "$CWD" = packages/smithers ] && { [ ! -x "$PG_SERVER_BIN/initdb" ] || [ ! -x "$PG_SERVER_BIN/pg_ctl" ]; }; then
  say "POSTGRES_TOOLS_MISSING: PostgreSQL 18 server tools are required for CLI tests; no install was attempted"
  exit 4
fi
PATH="$PATH:$PG_SERVER_BIN"
CLEAN=(env -i HOME="$HOME" USER="$USER" LOGNAME="$USER" SHELL=/bin/bash TERM=dumb LANG=C.UTF-8
  PATH="$PATH" "${PASS[@]+"${PASS[@]}"}" TMPDIR="$RUN_TMP" XDG_RUNTIME_DIR="$XDG_RUNTIME_DIR" FARM_RUN_ID="$FARM_RUN_ID")
cd "$DIR" || exit 3
now() { perl -MTime::HiRes=time -e 'printf "%.1f", time'; }
dt() { perl -e 'printf "%.1f", $ARGV[1] - $ARGV[0]' "$1" "$2"; }

# Install when the lockfile, the workspace config or any package.json changed since this slot's last install.
hash=$( { echo "$NODE_VERSION"; cat pnpm-lock.yaml pnpm-workspace.yaml .npmrc .pnpmfile.mjs 2>/dev/null;
  find . \( -name node_modules -o -name dist -o -name .alchemy -o -name target -o -name test-results -o -name .wrangler \) -prune \
    -o -name package.json -type f -print | LC_ALL=C sort | while read -r f; do echo "$f"; cat "$f"; done
} | shasum -a 256 | cut -c1-64)
stamp=$FARM/slot$SLOT.install
reuse=0
for setting in "${PASS[@]+"${PASS[@]}"}"; do
  [ "$setting" = LAT_RUN_REUSE_DEPS=1 ] && reuse=1
done
installed() { [ -d "$DIR/node_modules/.pnpm" ] && [ -d "$DIR/$CWD/node_modules" ]; }
saved_hash=$(cat "$stamp" 2>/dev/null)
if installed && { [ "$saved_hash" = "$hash" ] || { [ "$reuse" = 1 ] && [ "$saved_hash" = "$hash:$CWD" ]; }; }; then
  [ "$reuse" = 1 ] && say "reusing installed dependencies; install digest matches"
else
  installed || say "slot $SLOT: no usable installed dependencies"
  # Invalidate before attempting installation: a failed install must never look warm.
  rm -f "$stamp"
  t=$(now); say "slot $SLOT: dependencies missing or changed; pnpm install --frozen-lockfile --prefer-offline"
  install_log=$FARM/slot$SLOT.install.log
  run_install() {
    set -m
    "${CLEAN[@]}" pnpm "$@" install --frozen-lockfile --prefer-offline --config.optimistic-repeat-install=false --reporter=append-only >"$install_log" 2>&1 &
    installer=$!; echo "$installer" >>"$GROUPS_FILE"; set +m
    wait "$installer"
  }
  installed_hash=$hash
  if ! run_install; then
    # Only a manifest/lockfile mismatch permits a narrower frozen install.
    # pnpm still validates the selected package and its transitive dependencies.
    if [ "$reuse" = 1 ] && grep -q 'ERR_PNPM_OUTDATED_LOCKFILE' "$install_log"; then
      say "workspace lockfile mismatch; trying frozen install for ./$CWD and dependencies"
      installed_hash=$hash:$CWD
      cp "$install_log" "$install_log.workspace"
      # pnpm validates every declared importer even with --filter. Temporarily
      # narrow workspace membership to the manifest dependency closure.
      selection=$FARM/slot$SLOT.selection.json
      if ! "${CLEAN[@]}" pnpm -r list --depth -1 --json >"$selection"; then exit 4; fi
      workspace_backup=$FARM/slot$SLOT.workspace.yaml
      cp pnpm-workspace.yaml "$workspace_backup" || exit 4
      if ! node - "$selection" "$workspace_backup" "$CWD" <<'NODE'
const fs = require('fs'), path = require('path');
const projects = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
if (!projects.length) process.exit(1);
const byName = new Map(projects.map(p => [p.name, p]));
const selected = new Set();
const visit = p => {
  if (selected.has(p.path)) return;
  selected.add(p.path);
  const manifest = JSON.parse(fs.readFileSync(path.join(p.path, 'package.json'), 'utf8'));
  for (const name of Object.keys({...manifest.dependencies, ...manifest.devDependencies,
    ...manifest.optionalDependencies, ...manifest.peerDependencies})) {
    if (byName.has(name)) visit(byName.get(name));
  }
};
const target = projects.find(p => p.path === path.resolve(process.argv[4]));
if (!target) process.exit(1);
visit(target);
const dirs = [...selected].map(p => path.relative(process.cwd(), p)).filter(Boolean);
if (dirs.some(p => p.startsWith('../') || path.isAbsolute(p))) process.exit(1);
const original = fs.readFileSync(process.argv[3], 'utf8');
const narrowed = original.replace(/^packages:\s*\n(?:[ \t].*\n|\n|#.*\n)*/m,
  'packages:\n' + dirs.map(p => '  - ' + JSON.stringify(p)).join('\n') + '\n');
if (narrowed === original) process.exit(1);
fs.writeFileSync('pnpm-workspace.yaml', narrowed);
NODE
      then exit 4; fi
      run_install
      install_rc=$?
      cp "$workspace_backup" pnpm-workspace.yaml || exit 4
      rm -f "$workspace_backup"; workspace_backup=
      if [ "$install_rc" != 0 ]; then
        tail -40 "$install_log" >&2; say "install failed; full log on the host at $install_log"; exit 4
      fi
    else
      tail -40 "$install_log" >&2; say "install failed; full log on the host at $install_log"; exit 4
    fi
  fi
  installed || { say "install produced no usable dependencies"; exit 4; }
  echo "$installed_hash" >"$stamp"; say "slot $SLOT: installed in $(dt "$t" "$(now)") s"
fi


# Filesystem tests require the native helper; target/ is excluded from source sync.
case "$CWD" in packages/smithers|packages/smithers/flows/engine-store)
  say "checking native filesystem test dependency"
  set -m
  (
    flock -w 600 8 || exit 1
    CARGO_TARGET_DIR="$FARM/native" cargo build --locked -p smithers-ffi --bin smithers-jj-export
  ) 8>"$FARM/native-install.lock" >"$FARM/slot$SLOT.native-install.log" 2>&1 &
  native_pid=$!; echo "$native_pid" >>"$GROUPS_FILE"; set +m
  if ! wait "$native_pid"; then
    say "native dependency build failed; see $FARM/slot$SLOT.native-install.log"; exit 4;
  fi
  mkdir -p "$DIR/packages/smithers/flows/platform-node/bin/linux-x64" || exit 4
  cp "$FARM/native/debug/smithers-jj-export" "$DIR/packages/smithers/flows/platform-node/bin/linux-x64/smithers-jj-export" || exit 4
  ;;
esac

NET=()
# Light commands (typecheck, lint, import rules) need no app permit: permits bound heavy test suites only.
LIGHT=0
case " $* " in *vitest*|*e2e*|*playwright*|*" bench "*) ;; *importRules*) LIGHT=1;; *" test "*) ;; *" typecheck "*|*" tsc "*|*" lint "*|*" eslint "*) LIGHT=1;; esac
case "$CWD:$LIGHT" in apps/mvp:0|apps/mvp/*:0)
  # Slots remain independent; bound CPU/replication load from app suites per host.
  waiting=0; permit_start=$SECONDS
  while :; do
    acquired=0
    for permit in $(seq 1 "${LAT_APP_PERMITS:-$( [ "$(nproc)" -ge 48 ] && [ "$(cut -d. -f1 /proc/loadavg)" -lt 28 ] && echo 3 || echo 2)}"); do
      exec 7>"$FARM/app-permit$permit.lock"
      if flock -n 7; then acquired=1; break; fi
      exec 7>&-
    done
    [ "$acquired" = 1 ] && break
    if [ "$waiting" = 0 ]; then say "slot $SLOT: waiting for a host app permit"; waiting=1; fi
    [ $((SECONDS - permit_start)) -lt 120 ] || { say "APP_CAPACITY_TIMEOUT after 120s"; exit 75; }
    sleep 2
  done
  ;;
esac
case "$CWD" in
  apps/mvp|apps/mvp/*|packages/effect-electric|packages/smithers/flows/database)
    say "checking farm integration services"
    SERVICES_STARTED=1
    set -m
    "${CLEAN[@]}" bash "$FARM/services-slot$SLOT.sh" "$SLOT" 7>&- >"$FARM/slot$SLOT.services.log" 2>&1 &
    service_pid=$!; echo "$service_pid" >>"$GROUPS_FILE"; set +m
    if ! wait "$service_pid"; then tail -15 "$FARM/slot$SLOT.services.log" >&2; say "integration service setup failed; see $FARM/slot$SLOT.services.log"; exit 5; fi
    netpid=$(cat "$FARM/slot$SLOT.netpid")
    # A self-hosted matrix must retain lane's UID: initdb refuses unshare's root.
    case " $* " in
      *" test:matrix "*|*test-matrix.mjs*|*" coverage "*) ;;
      *) NET=(podman --root "$FARM/podman-v2/storage" --runroot "$FARM/podman-v2/run" unshare nsenter --net="/proc/$netpid/ns/net" --) ;;
    esac
    ;;
esac
# The CLI history/copy integration cases own a short-lived real PostgreSQL
# server. Keep lane's host UID (initdb refuses rootless-unshare UID 0).
if [ "$CWD" = packages/smithers ]; then
  CLEAN+=(NODE_OPTIONS=--no-experimental-webstorage SMITHERS_TEST_SOURCE_MIRROR=1 "SMITHERS_TEST_TRACKED_SOURCE_FILE=$FARM/slot$SLOT.tracked-source.txt")
  case " $* " in *test*|*coverage*)
    CLI_PGDATA="$RUN_TMP/pg"
    cli_pg_port=$("$NODE_BIN/node" -e 'const net=require("node:net"); const s=net.createServer(); s.listen(0,"127.0.0.1",()=>{process.stdout.write(String(s.address().port));s.close()})') || exit 4
    "$PG_SERVER_BIN/initdb" -D "$CLI_PGDATA" --no-locale --encoding=UTF8 --auth=trust -U lat_cli >"$FARM/slot$SLOT.cli-postgres-init.log" 2>&1 || exit 4
    "$PG_SERVER_BIN/pg_ctl" -D "$CLI_PGDATA" -o "-h 127.0.0.1 -p $cli_pg_port -k $RUN_TMP" -l "$RUN_TMP/pg.log" -w start >"$FARM/slot$SLOT.cli-postgres-start.log" 2>&1 || exit 4
    CLEAN+=("SMITHERS_HISTORY_TEST_PG_URL=postgres://lat_cli@127.0.0.1:$cli_pg_port/postgres")
    say "CLI PostgreSQL test service ready"
    ;;
  esac
fi
# Vitest's resolver honors this after CLI/config resolution, including pnpm
# scripts and shell wrappers. Bound direct clients as well as PgBouncer's pool.
CLEAN+=(VITEST_MAX_WORKERS=4)
cd "$DIR/$CWD" || exit 3
# The command gets its own process group, which the watcher stops if the MacBook's side goes away.
set -m
"${NET[@]}" "${CLEAN[@]}" "$@" &
pid=$!
set +m
echo "$pid" >>"$GROUPS_FILE"
wait "$pid"; rc=$?
[ -e "$ABORTED" ] && exit "$rc" # the watcher is stopping everything
kill "$WATCHER" 2>/dev/null
exit "$rc"
