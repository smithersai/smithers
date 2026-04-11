#!/usr/bin/env bash
set -euo pipefail

# Run tests for every package that has a tests/ directory
for pkg_dir in packages/*/; do
  pkg_name=$(basename "$pkg_dir")
  test_dir="${pkg_dir}tests"

  if [ ! -d "$test_dir" ]; then
    continue
  fi

  files=()
  while IFS= read -r file; do
    files+=("$file")
  done < <(find "$test_dir" -type f \( -name '*.test.ts' -o -name '*.test.tsx' \) | sort)

  if [ "${#files[@]}" -eq 0 ]; then
    continue
  fi

  echo
  echo "==> packages/${pkg_name} (${#files[@]} test files)"
  for file in "${files[@]}"; do
    bun test "$file"
  done
done
