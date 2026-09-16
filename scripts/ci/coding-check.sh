#!/bin/sh
# Run repository checks against the exported revision, with its own lockfile
# and workspace-local build CLI. Never resolve declarations against the editor.
set -eu
export HOME="${HOME:-$(getent passwd "$(id -u)" | cut -d: -f6)}"
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
exec node packages/smithers/build/build-cli/src/main.js test "$@"
