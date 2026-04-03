#!/usr/bin/env bash
# Run the Worktree+MergeQueue feature workflow
# Usage: ./run.sh

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
# Root = main agent repo, NOT submodules/smithers — agents need access to scripts/smithers-workflow/ too
ROOT_DIR="$(cd "$SCRIPT_DIR/../../../.." && pwd)"

cd "$SCRIPT_DIR"

export USE_CLI_AGENTS=1
export SMITHERS_DEBUG=1
export SMITHERS_UNSAFE=1
unset ANTHROPIC_API_KEY

SMITHERS_CLI="${SMITHERS_CLI:-./node_modules/.bin/smithers}"

echo "Starting Worktree+MergeQueue feature workflow"
echo "Root directory: $ROOT_DIR"
echo "Press Ctrl+C to stop."
echo ""

bun "$SMITHERS_CLI" run workflow.tsx --input '{}' --root "$ROOT_DIR"
