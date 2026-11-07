#!/usr/bin/env bash
if [[ -f ~/lanes/env.sh ]]; then source ~/lanes/env.sh >/dev/null 2>&1; fi
set -euo pipefail
ROOT=$(cd -- "$(dirname -- "$0")" && pwd)
exec nice -n 10 python3 "$ROOT/broken.py"
