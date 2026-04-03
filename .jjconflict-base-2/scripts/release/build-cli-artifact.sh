#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"

usage() {
  cat <<'USAGE'
Usage:
  build-cli-artifact.sh \
    [--channel <canary|stable|local>] \
    [--version <version>] \
    [--output-dir <dir>]

Builds a CLI package archive into output-dir (default: dist/cli).
USAGE
}

channel="local"
version=""
output_dir="dist/cli"

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

if [[ -z "$version" ]]; then
  version="$(bun --print "require('${REPO_ROOT}/apps/cli/package.json').version")"
fi

case "$output_dir" in
  /*)
    resolved_output_dir="$output_dir"
    ;;
  *)
    resolved_output_dir="${REPO_ROOT}/${output_dir}"
    ;;
esac

mkdir -p "$resolved_output_dir"

tmp_dir="${REPO_ROOT}/.tmp/cli-pack-$$"
mkdir -p "$tmp_dir"

packed_path="$(
  cd "${REPO_ROOT}/apps/cli"
  bun pm pack --destination "$tmp_dir" --quiet
)"
packed_path="$(printf '%s\n' "$packed_path" | tail -n 1)"

case "$packed_path" in
  /*)
    source_artifact="$packed_path"
    ;;
  *)
    source_artifact="${tmp_dir}/${packed_path}"
    ;;
esac

archive_name="burns-cli-${channel}-${version}.tgz"
archive_path="${resolved_output_dir}/${archive_name}"

cp "$source_artifact" "$archive_path"
rm -rf "$tmp_dir"

echo "cli artifact: ${archive_path}"
