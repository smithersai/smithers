#!/usr/bin/env bash
# The default owns its dependencies; a caller with an isolated fixture supplies its endpoints explicitly.
set -euo pipefail
app_directory=$(cd "$(dirname "$0")/.." && pwd)
case "${MVP_TEST_STACK:-owned}" in
  owned) exec bash "$app_directory/db/test-stack.sh" -- vitest run "$@" ;;
  external) exec vitest run "$@" ;;
  *) echo 'MVP_TEST_STACK must be owned or external' >&2; exit 64 ;;
esac
