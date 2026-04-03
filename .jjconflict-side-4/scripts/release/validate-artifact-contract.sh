#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'USAGE'
Usage:
  validate-artifact-contract.sh --dir <artifact-dir>

Validates artifact names against:
  burns-{channel}-{component}-{version}-{target_os}-{target_arch}[{-ordinal}].{ext}
USAGE
}

directory=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --dir)
      directory="$2"
      shift 2
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

if [[ -z "$directory" ]]; then
  echo "--dir is required" >&2
  usage >&2
  exit 1
fi

if [[ ! -d "$directory" ]]; then
  echo "artifact directory does not exist: $directory" >&2
  exit 1
fi

invalid_count=0

while IFS= read -r file_name; do
  case "$file_name" in
    artifact-manifest.txt|SHA256SUMS.txt)
      continue
      ;;
  esac

  if [[ ! "$file_name" =~ ^burns-(canary|stable)-(desktop|cli)-[A-Za-z0-9._+-]+-(darwin|linux|windows)-(arm64|x64)(-[0-9]+)?\.[A-Za-z0-9]+$ ]]; then
    echo "invalid artifact name: $file_name" >&2
    invalid_count=$((invalid_count + 1))
  fi
done < <(find "$directory" -maxdepth 1 -type f -exec basename {} \; | sort)

if [[ "$invalid_count" -gt 0 ]]; then
  echo "artifact naming validation failed (${invalid_count} invalid file(s))" >&2
  exit 1
fi

echo "artifact naming validation passed"
