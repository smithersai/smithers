#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'USAGE'
Usage:
  build-desktop-artifact.sh \
    --channel <canary|stable> \
    --version <version> \
    [--output-dir <dir>]

Builds ElectroBun desktop output and archives it into output-dir (default: dist/desktop).
USAGE
}

channel=""
version=""
output_dir="dist/desktop"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --channel)
      channel="$2"
      shift 2
      ;;
    --version)
      version="$2"
      shift 2
      ;;
    --output-dir)
      output_dir="$2"
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

if [[ -z "$channel" || -z "$version" ]]; then
  echo "--channel and --version are required" >&2
  usage >&2
  exit 1
fi

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd "${script_dir}/../.." && pwd)"

if [[ "$channel" == "canary" ]]; then
  (
    cd "$repo_root"
    bun run desktop:build:canary
  )
elif [[ "$channel" == "stable" ]]; then
  (
    cd "$repo_root"
    bun run desktop:build:stable
  )
else
  echo "Invalid --channel value: $channel" >&2
  exit 1
fi

if [[ "$output_dir" = /* ]]; then
  resolved_output_dir="$output_dir"
else
  resolved_output_dir="${repo_root}/${output_dir}"
fi

desktop_build_dir="${repo_root}/dist/desktop/build"
desktop_artifact_dir="${repo_root}/dist/desktop/artifacts"

if [[ ! -d "$desktop_build_dir" ]]; then
  echo "Desktop build output directory not found: $desktop_build_dir" >&2
  exit 1
fi

if [[ ! -d "$desktop_artifact_dir" ]]; then
  echo "Desktop artifact directory not found: $desktop_artifact_dir" >&2
  exit 1
fi

mkdir -p "$resolved_output_dir"
archive_name="burns-desktop-${channel}-${version}.tar.gz"
archive_path="${resolved_output_dir}/${archive_name}"

echo "[desktop artifact] archiving dist/desktop/{build,artifacts} -> ${archive_path}"
tar -czf "$archive_path" -C "${repo_root}" "dist/desktop/build" "dist/desktop/artifacts"

echo "[desktop artifact] done: ${archive_path}"
