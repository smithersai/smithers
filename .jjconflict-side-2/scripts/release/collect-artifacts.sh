#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ARTIFACT_NAME_SCRIPT="${SCRIPT_DIR}/artifact-name.sh"

usage() {
  cat <<'USAGE'
Usage:
  collect-artifacts.sh \
    --channel <canary|stable> \
    --version <version> \
    --target-os <darwin|linux|windows> \
    --target-arch <arm64|x64> \
    [--desktop-pattern <glob>] \
    [--cli-pattern <glob>] \
    [--output-dir <dir>] \
    [--strict]

Collects desktop and CLI artifacts into output-dir using the naming contract.
When patterns do not match:
- default: writes a placeholder text artifact
- --strict: exits with error
USAGE
}

channel=""
version=""
target_os=""
target_arch=""
desktop_pattern=""
cli_pattern=""
output_dir="release-artifacts"
strict="0"

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
    --target-os)
      target_os="$2"
      shift 2
      ;;
    --target-arch)
      target_arch="$2"
      shift 2
      ;;
    --desktop-pattern)
      desktop_pattern="$2"
      shift 2
      ;;
    --cli-pattern)
      cli_pattern="$2"
      shift 2
      ;;
    --output-dir)
      output_dir="$2"
      shift 2
      ;;
    --strict)
      strict="1"
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

if [[ -z "$channel" || -z "$version" || -z "$target_os" || -z "$target_arch" ]]; then
  echo "Missing required arguments" >&2
  usage >&2
  exit 1
fi

mkdir -p "$output_dir"
manifest_path="${output_dir}/artifact-manifest.txt"
: > "$manifest_path"

echo "channel=${channel}" >> "$manifest_path"
echo "version=${version}" >> "$manifest_path"
echo "target_os=${target_os}" >> "$manifest_path"
echo "target_arch=${target_arch}" >> "$manifest_path"

collect_component() {
  local component="$1"
  local pattern="$2"

  if [[ -z "$pattern" ]]; then
    echo "${component}: skipped (no pattern configured)" >> "$manifest_path"
    return 0
  fi

  local matches=()
  while IFS= read -r path; do
    matches+=("$path")
  done < <(compgen -G "$pattern" || true)

  if [[ ${#matches[@]} -eq 0 ]]; then
    if [[ "$strict" == "1" ]]; then
      echo "${component}: no files matched pattern '$pattern'" >&2
      return 1
    fi

    local placeholder
    placeholder="$("$ARTIFACT_NAME_SCRIPT" \
      --channel "$channel" \
      --component "$component" \
      --version "$version" \
      --target-os "$target_os" \
      --target-arch "$target_arch" \
      --extension "txt")"

    {
      echo "${component} artifact is not yet wired for this pipeline."
      echo "expected pattern: $pattern"
      echo "generated at: $(date -u +%Y-%m-%dT%H:%M:%SZ)"
    } > "${output_dir}/${placeholder}"

    echo "${component}: placeholder -> ${output_dir}/${placeholder}" >> "$manifest_path"
    return 0
  fi

  local index=1
  local total="${#matches[@]}"
  for source_path in "${matches[@]}"; do
    local extension="${source_path##*.}"
    if [[ "$extension" == "$source_path" ]]; then
      extension="bin"
    fi

    local ordinal=""
    if [[ "$total" -gt 1 ]]; then
      ordinal="$index"
    fi

    local artifact_name_args=(
      --channel "$channel"
      --component "$component"
      --version "$version"
      --target-os "$target_os"
      --target-arch "$target_arch"
      --extension "$extension"
    )

    if [[ -n "$ordinal" ]]; then
      artifact_name_args+=(--ordinal "$ordinal")
    fi

    local target_name
    target_name="$("$ARTIFACT_NAME_SCRIPT" "${artifact_name_args[@]}")"

    cp "$source_path" "${output_dir}/${target_name}"
    echo "${component}: ${source_path} -> ${output_dir}/${target_name}" >> "$manifest_path"
    index=$((index + 1))
  done
}

collect_component "desktop" "$desktop_pattern"
collect_component "cli" "$cli_pattern"

echo "manifest: ${manifest_path}"
