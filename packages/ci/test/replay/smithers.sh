#!/bin/bash
# Replays the last commits of main for packages/ci and prints the replay report as JSON.
# Usage: smithers.sh [commits] [comma-separated targets]
set -euo pipefail
ci=$(cd "$(dirname "$0")/../.." && pwd)
workspace=$(cd "$ci/../.." && pwd)
commits=${1:-5}
targets=${2:-check,lint,fmt,circular,lib,docs,test}
scratch=${REPLAY_SCRATCH:-$HOME/ci/sci-replay-scratch}
root=$scratch/smithers-main
store=$(jj -R "$workspace" git root)
mkdir -p "$scratch/tmp"
rm -rf "$root"
git init --quiet --initial-branch=main "$root"
git -C "$root" fetch --quiet --update-head-ok --depth=$((commits + 1)) "$store" +refs/remotes/origin/main:refs/heads/main
cd "$ci"
VIBELANG_PROJECT=$ci/tsconfig.test.json TMPDIR=$scratch/tmp REPLAY_ROOT=$root REPLAY_COMMITS=$commits REPLAY_TARGETS=$targets \
  node --import vibelang/register test/replay/smithers.vibe
