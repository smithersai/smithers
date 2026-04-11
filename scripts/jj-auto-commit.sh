#!/bin/zsh
# jj-auto-commit: Create atomic emoji conventional commits grouped by package.
# Designed to run on a 5-minute cron via launchd.
set -eo pipefail

REPO_DIR="${JJ_AUTO_COMMIT_REPO:-/Users/williamcory/smithers}"
cd "$REPO_DIR"

# ── gather changes ──────────────────────────────────────────────────
changes=$(jj diff --summary 2>/dev/null || true)
if [[ -z "$changes" ]]; then
  exit 0
fi

# ── temp dir for grouping ───────────────────────────────────────────
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT

# ── group files by package ──────────────────────────────────────────
while IFS= read -r line; do
  [[ -z "$line" ]] && continue
  change_type="${line%% *}"
  file_path="${line#* }"

  if [[ "$file_path" == packages/* ]]; then
    # packages/core/src/foo.ts -> packages__core
    pkg_dir=$(echo "$file_path" | cut -d/ -f2)
    group="packages/${pkg_dir}"
    safe="packages__${pkg_dir}"
  elif [[ "$file_path" == tests/* ]] || [[ "$file_path" == *".test."* ]] || [[ "$file_path" == *".spec."* ]]; then
    group="__tests__"
    safe="__tests__"
  else
    group="__root__"
    safe="__root__"
  fi

  echo "${change_type} ${file_path}" >> "${work}/${safe}"
  # Track group->safe mapping
  echo "${group}	${safe}" >> "${work}/_groups"
done <<< "$changes"

# ── deduplicate and sort groups ─────────────────────────────────────
if [[ ! -f "${work}/_groups" ]]; then
  exit 0
fi
groups=("${(@f)$(awk -F'\t' '!seen[$1]++ {print $1 "\t" $2}' "${work}/_groups" | sort)}")
total_groups=${#groups}

echo "$(date '+%Y-%m-%d %H:%M:%S') — ${total_groups} group(s) to commit"

# ── helpers ─────────────────────────────────────────────────────────
count_type() {
  local n
  n=$(grep -c "^${1} " "$2" 2>/dev/null) || true
  echo "${n:-0}"
}

build_message() {
  local group="$1" datafile="$2"

  local added=$(count_type "A" "$datafile")
  local modified=$(count_type "M" "$datafile")
  local deleted=$(count_type "D" "$datafile")
  local renamed=$(count_type "R" "$datafile")
  local total=$((added + modified + deleted + renamed))
  (( total == 0 )) && total=1  # guard

  # ── scope ──
  local scope=""
  case "$group" in
    packages/*) scope="${group#packages/}" ;;
    __tests__)  scope="test" ;;
    __root__)   scope="" ;;
  esac

  # ── detect special file categories ──
  local test_n; test_n=$(awk '{print $2}' "$datafile" | grep -cE '(\.test\.|\.spec\.|/tests/)') || true; test_n=${test_n:-0}
  local doc_n; doc_n=$(awk '{print $2}' "$datafile" | grep -cE '\.(md|txt)$|/docs/') || true; doc_n=${doc_n:-0}
  local cfg_n; cfg_n=$(awk '{print $2}' "$datafile" | grep -cE '(package\.json|tsconfig|\.config\.)') || true; cfg_n=${cfg_n:-0}

  # ── classify ──
  local emoji type
  if (( test_n * 2 > total )); then
    emoji="🧪"; type="test"
  elif (( doc_n * 2 > total )); then
    emoji="📝"; type="docs"
  elif (( cfg_n * 2 > total )); then
    emoji="🔧"; type="chore"
  elif (( deleted > 0 && added == 0 && modified == 0 )); then
    emoji="🗑️"; type="chore"
  elif (( renamed * 2 > total )); then
    emoji="♻️"; type="refactor"
  elif (( added * 2 > total )); then
    emoji="✨"; type="feat"
  elif (( modified * 2 > total )); then
    emoji="🔧"; type="chore"
  else
    emoji="🔧"; type="chore"
  fi

  # ── description ──
  local desc_parts=()
  (( added   > 0 )) && desc_parts+=("add ${added} files")
  (( modified > 0 )) && desc_parts+=("update ${modified} files")
  (( deleted > 0 )) && desc_parts+=("remove ${deleted} files")
  (( renamed > 0 )) && desc_parts+=("rename ${renamed} files")
  local desc="${(j:, :)desc_parts}"

  if [[ -n "$scope" ]]; then
    echo "${emoji} ${type}(${scope}): ${desc}"
  else
    echo "${emoji} ${type}: ${desc}"
  fi
}

# ── commit each group ───────────────────────────────────────────────
for (( i=1; i<=total_groups; i++ )); do
  entry="${groups[$i]}"
  group="${entry%%	*}"
  safe="${entry##*	}"
  datafile="${work}/${safe}"

  message=$(build_message "$group" "$datafile")
  echo "  [$i/$total_groups] $message"

  if (( i < total_groups )); then
    # Split matching files into their own commit; rest stays in @
    if [[ "$group" == packages/* ]]; then
      jj split -m "$message" -- "${group}"
    else
      # Root or test files — pass individual paths
      local files=("${(@f)$(awk '{print $2}' "$datafile")}")
      jj split -m "$message" -- "${files[@]}"
    fi
  else
    # Last group: commit everything remaining
    jj commit -m "$message"
  fi
done

echo "$(date '+%Y-%m-%d %H:%M:%S') — done, ${total_groups} atomic commit(s) created"
