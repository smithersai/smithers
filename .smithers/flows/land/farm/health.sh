#!/usr/bin/env bash
# Read-only admission checks. No pruning, service restarts, or retries.
set -euo pipefail
root=${1:-$HOME}
minimum=${FARM_MIN_FREE_KB:-20971520}
maximum=${FARM_MAX_USED_PERCENT:-95}
[[ "$minimum" =~ ^[0-9]+$ && "$maximum" =~ ^[0-9]+$ ]] && [ "$maximum" -le 100 ] || { echo 'FARM_HEALTH invalid disk thresholds' >&2; exit 2; }
[ -d "$root" ] || { echo 'FARM_HEALTH mirror root is missing' >&2; exit 3; }
read -r available percent < <(df -Pk "$root" | awk 'NR==2 {gsub(/%/,"",$5); print $4, $5}')
[[ "$available" =~ ^[0-9]+$ && "$percent" =~ ^[0-9]+$ ]] || { echo 'FARM_HEALTH could not read disk availability' >&2; exit 3; }
if [ "$available" -lt "$minimum" ] || [ "$percent" -gt "$maximum" ]; then
  printf 'FARM_HEALTH DISK_FULL free_kb=%s used_percent=%s required_free_kb=%s max_used_percent=%s; no data was removed\n' "$available" "$percent" "$minimum" "$maximum" >&2
  exit 73
fi
printf 'FARM_HEALTH ready free_kb=%s used_percent=%s\n' "$available" "$percent" >&2
