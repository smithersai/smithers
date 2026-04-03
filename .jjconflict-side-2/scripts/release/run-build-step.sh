#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'USAGE'
Usage:
  run-build-step.sh --label <name> [--command <cmd>] [--required]

Executes a release build command if provided.
- When --command is empty and --required is not set, the step is skipped.
- When --required is set, an empty command is treated as an error.
USAGE
}

label=""
command=""
required="0"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --label)
      label="$2"
      shift 2
      ;;
    --command)
      command="$2"
      shift 2
      ;;
    --required)
      required="1"
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "Unknown argument: $1" >&2
      usage >&2
      exit 1
      ;;
  esac
done

if [[ -z "$label" ]]; then
  echo "--label is required" >&2
  usage >&2
  exit 1
fi

if [[ -z "$command" ]]; then
  if [[ "$required" == "1" ]]; then
    echo "[$label] command is required but missing" >&2
    exit 1
  fi

  echo "[$label] skipped (no command configured)"
  exit 0
fi

echo "[$label] running: $command"
bash -lc "$command"
