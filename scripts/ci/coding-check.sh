#!/bin/sh
# Run repository checks against the exported revision, with its own lockfile
# and workspace-local build CLI. Never resolve declarations against the editor.
set -eu
export HOME="${HOME:-$(getent passwd "$(id -u)" | cut -d: -f6)}"
# Every check runs in a fresh export. Target results and downloaded packages
# persist in a host check cache (scripts/ci/check-cache.mjs) so a rebased
# revision replays every target whose content key is unchanged. The Bun cache
# is content-addressed and dedicated to checks, never the developer's own.
cache_root="${SMITHERS_CHECK_CACHE_DIR:-$HOME/.cache/smithers-checks/cache}"
export BUN_INSTALL_CACHE_DIR="$cache_root/bun"
# Bun can stop making progress after populating its cache. Bound bootstrap
# independently of the test deadline and retry only a timed-out installation.
install_attempt=1
while :; do
  install_status=0
  timeout --kill-after=5s "${SMITHERS_CHECK_INSTALL_TIMEOUT:-120s}" bun install --frozen-lockfile >&2 || install_status=$?
  [ "$install_status" -eq 0 ] && break
  case "$install_status" in
    124|137)
      [ "$install_attempt" -lt 2 ] || exit "$install_status"
      echo 'Dependency installation timed out; retrying once.' >&2
      install_attempt=$((install_attempt + 1))
      ;;
    *) exit "$install_status" ;;
  esac
done
# A cache failure only costs reuse, never the check's own verdict.
node scripts/ci/check-cache.mjs seed . || echo 'Check cache unavailable; running cold.' >&2
# The check is a child rather than exec'd so the cache can be saved after it;
# forward termination so signalling this wrapper still stops the check.
node packages/smithers/build/build-cli/src/main.js test "$@" &
check_pid=$!
trap 'kill -TERM "$check_pid" 2>/dev/null; wait "$check_pid"; exit 143' TERM INT HUP
test_status=0
wait "$check_pid" || test_status=$?
trap - TERM INT HUP
node scripts/ci/check-cache.mjs save . || echo 'Check cache could not be saved.' >&2
exit "$test_status"
