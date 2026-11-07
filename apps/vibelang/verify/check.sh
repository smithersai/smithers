#!/usr/bin/env bash
if [[ -f ~/lanes/env.sh ]]; then source ~/lanes/env.sh >/dev/null 2>&1; fi
set -euo pipefail
ROOT=$(cd -- "$(dirname -- "$0")" && pwd)
if [[ ! -x "$ROOT/.tools/bin/lsc" || ! -x "$ROOT/.tools/bin/dafny" ]]; then
  nice -n 10 bash "$ROOT/install.sh"
fi
export PATH="$ROOT/.tools/bin:$PATH"
exec nice -n 10 python3 "$ROOT/check.py" "${1:-$ROOT/../src/core/conversation.ts}"
