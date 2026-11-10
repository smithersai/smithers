#!/usr/bin/env bash
# Regenerate and verify LemmaScript artifacts, running the toolchain FROM SOURCE
# (this checkout) — so case studies and CI validate the current tree. The batch
# loop lives in `lsc` itself (runBatch in src/lsc.ts, reading
# LemmaScript-files.txt); installed-package consumers get the same loop as `lsc check`.
# Usage: ./check.sh <lean|dafny|dafny-slow> [file.ts ...]
set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
LSC="npx --prefix $SCRIPT_DIR tsx $SCRIPT_DIR/src/lsc.ts"

backend="${1:-all}"; shift 2>/dev/null || true

case "$backend" in
  lean)
    if [ $# -gt 0 ]; then for f in "$@"; do $LSC gen --backend=lean "$f"; done
    else $LSC gen --backend=lean; fi
    lake build
    ;;
  dafny)
    if [ $# -gt 0 ]; then for f in "$@"; do $LSC check --backend=dafny "$f"; done
    else $LSC check --backend=dafny; fi
    ;;
  dafny-slow)
    if [ $# -gt 0 ]; then for f in "$@"; do $LSC check --backend=dafny "$f"; done
    else $LSC check --backend=dafny --slow; fi
    ;;
  all)
    "$0" lean "$@"
    "$0" dafny "$@"
    ;;
  *)
    echo "Usage: check.sh [lean|dafny|dafny-slow] [file.ts ...]"
    exit 1
    ;;
esac
