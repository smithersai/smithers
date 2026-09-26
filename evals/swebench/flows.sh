#!/bin/bash
# Runs this checkout's flows CLI against the caller's working directory.
#
#   flows.sh [--json] <verb> [args...]
#
# The benchmark drives the CLI from an extracted SWE-bench testbed, which is an
# arbitrary directory outside this repository. The CLI reads its project flows
# from the working directory (`<cwd>/flows/<name>/flow.mdx`) and keeps its
# control database in `<cwd>/.flows`, so the wrapper changes no directory: it
# only resolves the executable out of the checkout and execs it in place.
#
# `packages/smithers/bin/smithers.mjs` is the shipped executable — the file
# `@smthrs/cli` declares as its `smithers` bin. It runs `dist/esm/bin.js` when a
# build is there and falls back to `src/bin.ts` under Node's type stripping when
# it is not, so a source checkout has a working CLI with no build step.
#
# That fallback is convenient and, for a wave, wrong: the pinned subject is the
# build, and a silent fall back to source would run bytes nothing fingerprinted.
# So this wrapper checks the build is present before it execs the shim, and the
# pin below re-derives the fingerprint of exactly those bytes.
#
# This wrapper does not build. `./preflight.sh` does, once, and pins what it
# built to `.subject.json`; every invocation here re-derives the fingerprint and
# refuses to run when it has moved. Building here instead was how waves 5 and 6
# came to be reported against commits nothing had verified they ran: the old
# rule was "build only when `bin.js` is missing", which after the first wave is
# never, and the CLI's dependencies are loaded from the working tree, which
# sibling lanes edit while a wave is in flight.
#
# SWB_SUBJECT_UNPINNED=1 skips the check. Use it for one-off CLI calls by hand,
# never for a wave.
set -u
S="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$S/../.." && pwd)"
BIN="$ROOT/packages/smithers/bin/smithers.mjs"
BUILT="$ROOT/packages/smithers/dist/esm/bin.js"

if [ "${SWB_SUBJECT_UNPINNED:-0}" != "1" ]; then
  if [ ! -f "$S/.subject.json" ]; then
    echo "flows.sh: no subject is pinned. Run evals/swebench/preflight.sh first," >&2
    echo "  or set SWB_SUBJECT_UNPINNED=1 for a one-off call outside a wave." >&2
    exit 1
  fi
  node "$S/lib/subject.mjs" --expect "$S/.subject.json" --quiet || exit $?
fi

if [ ! -f "$BIN" ]; then
  echo "flows.sh: $BIN does not exist; this is not a Smithers checkout" >&2
  exit 1
fi

if [ ! -f "$BUILT" ]; then
  echo "flows.sh: $BUILT does not exist, so $BIN would fall back to src/bin.ts." >&2
  echo "  That is not the subject a wave pins. Run evals/swebench/preflight.sh." >&2
  exit 1
fi

# A wave is unattended: an `ask` the model sends a person refuses at once
# (ApprovalUnavailable, journalled) instead of parking the run on an approval
# nobody will grant until its budget runs out. evals/harbor sets the same.
export SMITHERS_ASKS=refuse
exec node "$BIN" "$@"
