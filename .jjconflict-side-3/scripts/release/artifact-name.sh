#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'USAGE'
Usage:
  artifact-name.sh \
    --channel <canary|stable> \
    --component <desktop|cli> \
    --version <version> \
    --target-os <darwin|linux|windows> \
    --target-arch <arm64|x64> \
    --extension <ext> \
    [--ordinal <n>]

Prints an artifact file name that follows the release naming contract.
USAGE
}

channel=""
component=""
version=""
target_os=""
target_arch=""
extension=""
ordinal=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --channel)
      channel="$2"
      shift 2
      ;;
    --component)
      component="$2"
      shift 2
      ;;
    --version)
      version="$2"
      shift 2
      ;;
    --target-os)
      target_os="$2"
      shift 2
      ;;
    --target-arch)
      target_arch="$2"
      shift 2
      ;;
    --extension)
      extension="$2"
      shift 2
      ;;
    --ordinal)
      ordinal="$2"
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

if [[ -z "$channel" || -z "$component" || -z "$version" || -z "$target_os" || -z "$target_arch" || -z "$extension" ]]; then
  echo "Missing required arguments" >&2
  usage >&2
  exit 1
fi

if [[ "$channel" != "canary" && "$channel" != "stable" ]]; then
  echo "Invalid channel: $channel" >&2
  exit 1
fi

if [[ "$component" != "desktop" && "$component" != "cli" ]]; then
  echo "Invalid component: $component" >&2
  exit 1
fi

base="burns-${channel}-${component}-${version}-${target_os}-${target_arch}"
if [[ -n "$ordinal" ]]; then
  base="${base}-${ordinal}"
fi

echo "${base}.${extension}"
