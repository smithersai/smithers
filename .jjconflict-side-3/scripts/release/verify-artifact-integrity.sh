#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'USAGE'
Usage:
  verify-artifact-integrity.sh --dir <artifact-dir> [--reject-placeholders]

Checks that release artifacts are non-empty and writes SHA256SUMS.txt.
When --reject-placeholders is set, placeholder text artifacts fail validation.
USAGE
}

directory=""
reject_placeholders="0"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --dir)
      directory="$2"
      shift 2
      ;;
    --reject-placeholders)
      reject_placeholders="1"
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

if [[ -z "$directory" ]]; then
  echo "--dir is required" >&2
  usage >&2
  exit 1
fi

if [[ ! -d "$directory" ]]; then
  echo "artifact directory does not exist: $directory" >&2
  exit 1
fi

checksum_file="${directory}/SHA256SUMS.txt"
: > "$checksum_file"

artifact_count=0
invalid_count=0
placeholder_count=0

while IFS= read -r file_path; do
  file_name="$(basename "$file_path")"

  case "$file_name" in
    artifact-manifest.txt|SHA256SUMS.txt)
      continue
      ;;
  esac

  artifact_count=$((artifact_count + 1))

  if [[ ! -s "$file_path" ]]; then
    echo "artifact is empty: $file_name" >&2
    invalid_count=$((invalid_count + 1))
    continue
  fi

  if grep -q "artifact is not yet wired for this pipeline" "$file_path" 2>/dev/null; then
    echo "placeholder artifact detected: $file_name" >&2
    placeholder_count=$((placeholder_count + 1))
  fi

  if command -v sha256sum >/dev/null 2>&1; then
    hash="$(sha256sum "$file_path" | awk '{print $1}')"
  elif command -v shasum >/dev/null 2>&1; then
    hash="$(shasum -a 256 "$file_path" | awk '{print $1}')"
  else
    echo "Neither sha256sum nor shasum is available" >&2
    exit 1
  fi

  printf '%s  %s\n' "$hash" "$file_name" >> "$checksum_file"
done < <(find "$directory" -maxdepth 1 -type f | sort)

if [[ "$artifact_count" -eq 0 ]]; then
  echo "no artifacts found in: $directory" >&2
  exit 1
fi

if [[ "$invalid_count" -gt 0 ]]; then
  echo "artifact integrity validation failed (${invalid_count} invalid artifact(s))" >&2
  exit 1
fi

if [[ "$reject_placeholders" == "1" && "$placeholder_count" -gt 0 ]]; then
  echo "artifact integrity validation failed (${placeholder_count} placeholder artifact(s))" >&2
  exit 1
fi

echo "artifact integrity validation passed"
echo "checksums written to ${checksum_file}"
