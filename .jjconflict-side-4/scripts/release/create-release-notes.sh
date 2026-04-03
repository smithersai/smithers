#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'USAGE'
Usage:
  create-release-notes.sh \
    --channel <canary|stable> \
    --version <version> \
    [--commit <sha>] \
    [--output <path>]

Generates a release-notes markdown template.
USAGE
}

channel=""
version=""
commit_sha=""
output_path=""

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
    --commit)
      commit_sha="$2"
      shift 2
      ;;
    --output)
      output_path="$2"
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

if [[ -z "$output_path" ]]; then
  output_path="release-notes-${channel}-${version}.md"
fi

release_date="$(date -u +%Y-%m-%d)"
title_channel="$(printf '%s' "$channel" | awk '{print toupper(substr($0,1,1)) substr($0,2)}')"

cat > "$output_path" <<NOTES
# Burns ${title_channel} Release ${version}

- Date: ${release_date}
- Channel: ${channel}
- Commit: ${commit_sha:-<fill-in>}

## Highlights

- <feature/fix 1>
- <feature/fix 2>

## Artifact Summary

- Desktop:
  - 
- CLI:
  - 

## Validation

- [ ] Smoke tests executed
- [ ] Artifact naming contract validated
- [ ] Changelog updated

## Rollback Notes

- Trigger: <condition>
- Action: <rollback command or workflow>
- Verification: <post-rollback checks>
NOTES

echo "release notes template written to ${output_path}"
