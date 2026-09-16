#!/bin/sh
# Run repository checks against the exported revision, with its own lockfile
# and workspace-local build CLI. Never resolve declarations against the editor.
set -eu
export HOME="${HOME:-$(getent passwd "$(id -u)" | cut -d: -f6)}"
bun install --frozen-lockfile >&2
exec node packages/smithers/build/build-cli/src/main.js test "$@"
