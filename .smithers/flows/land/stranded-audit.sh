#!/bin/bash
# Repeat the 2026-11-01 stranded-commit audit (PROC-26). Read-only for both repositories.
# Usage: stranded-audit.sh <tree: empty workspace at main@origin> <out dir>
set -euo pipefail
TREE=${1:?tree}; OUT=${2:?out dir}
HERE=$(cd "$(dirname "$0")" && pwd)
HOLD=${HOLD:-$HOME/smithers-builders/w12-hold}
SMITHERS=${SMITHERS:-$HOME/smithers}
SINCE=${SINCE:-$(date -v-30d +%Y-%m-%d)}
mkdir -p "$OUT"
CANDIDATES='~::main@origin & ~empty() & ~::remote_bookmarks(remote=origin)'
# w12-hold: lane land-effect owns main@origin..builder/effect-upgrade and its copies.
node "$HERE/stranded.mjs" --repo "$HOLD" --tree "$TREE" --revset "$CANDIDATES" \
  --exclude '::builder/effect-upgrade' --exclude-copies-of 'main@origin..builder/effect-upgrade' \
  --skip-live --own stranded-audit,stranded-ref --jobs 8 --json "$OUT/hold.json" --md "$OUT/hold.md" --title 'w12-hold'
# ~/smithers: last 30 days; w12-hold's own bookmarks were judged above.
node "$HERE/stranded.mjs" --repo "$SMITHERS" --tree "$TREE" --revset "$CANDIDATES" --since "$SINCE" \
  --exclude '::remote_bookmarks(remote=w12hold)' --skip-live --jobs 8 --json "$OUT/smithers.json" --md "$OUT/smithers.md" --title "~/smithers (since $SINCE)"
