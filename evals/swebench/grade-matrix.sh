#!/bin/bash
# Grades a best-of-n matrix with the official evaluator, in three groups.
#
#   grade-matrix.sh <run-prefix> [all|flows|codex|select|selected] [count]
#
# The evaluator keys its predictions by instance id, so one instance can carry
# exactly one patch per grading. A matrix of `count` runs per instance is
# therefore `count` gradings per side, one per round, and the selected patches
# are one more:
#
#   flows     <prefix>-flows-r1 … -r<count>     patches/<id>-r<n>.patch
#   codex     <prefix>-codex-r1 … -r<count>     patches-codex/<id>-r<n>.patch
#   selected  <prefix>-selected                 selected/<id>.patch
#
# `select` runs `select-candidate.mjs` over the archived journals first and then
# grades what it chose. The selection is made from journals and patches alone,
# before any of this — see that script's header. Running the selector after a
# grading changes nothing about what it reads, but grading first and selecting
# second is the order that invites a mistake, so `all` does it the other way
# round: select, then grade every group.
#
# Grading is serialized inside each group by `evaluate.sh` (SWB_EVAL_WORKERS
# defaults to 1 because concurrent workers lose the report) and the groups run
# one after another here for the same reason.
#
# This needs docker and the official images. It spends no model tokens.
set -u
S="$(cd "$(dirname "$0")" && pwd)"
PREFIX="${1:-}"
GROUP="${2:-all}"
COUNT="${3:-5}"
SAMPLE_COUNT="${SWB_SAMPLE_COUNT:-5}"

if [ -z "$PREFIX" ]; then
  echo "usage: grade-matrix.sh <run-prefix> [all|flows|codex|select|selected] [count]"; exit 2
fi
case "$GROUP" in
  all|flows|codex|select|selected) ;;
  *) echo "group must be all, flows, codex, select or selected"; exit 2 ;;
esac
case "$COUNT" in
  ''|*[!0-9]*|0) echo "count must be a positive integer"; exit 2 ;;
esac
if [ ! -f "$S/sample.json" ]; then
  echo "no sample at $S/sample.json — run ./bootstrap.sh first"; exit 1
fi

IDS="$(node -e '
const fs=require("fs");
const s=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));
process.stdout.write(s.instances.slice(0,Number(process.argv[2])).join(" "));
' "$S/sample.json" "$SAMPLE_COUNT")"

STATUS=0

# The flows roots the matrix wrote into, SWB_ARTIFACT_ROOT included, so the
# selector reads and writes where the runs did and `evaluate.sh` grades there.
ROOTS="$("$S/lib/run-paths.sh" flows --roots)" || exit 2
eval "$ROOTS"
SELECTED="$ARTIFACT_ROOT/selected"

select_candidates() {
  echo "== selecting, from journals and patches only"
  mkdir -p "$SELECTED"
  for ID in $IDS; do
    node "$S/select-candidate.mjs" "$ID" --journals "$JOURNAL_ROOT" --patches "$PATCH_ROOT" \
      --out "$SELECTED" || STATUS=$?
  done
}

grade_rounds() {
  HARNESS_NAME="$1"
  for ROUND in $(seq 1 "$COUNT"); do
    echo "== grading $HARNESS_NAME r$ROUND as $PREFIX-$HARNESS_NAME-r$ROUND"
    HARNESS="$HARNESS_NAME" SWB_PATCH_SUFFIX="-r$ROUND" \
      "$S/evaluate.sh" "$PREFIX-$HARNESS_NAME-r$ROUND" $IDS || STATUS=$?
  done
}

grade_selected() {
  echo "== grading the selected patches as $PREFIX-selected"
  SWB_PATCHES="$SELECTED" "$S/evaluate.sh" "$PREFIX-selected" $IDS || STATUS=$?
}

case "$GROUP" in
  select) select_candidates ;;
  selected) select_candidates; grade_selected ;;
  flows) grade_rounds flows ;;
  codex) grade_rounds codex ;;
  all)
    select_candidates
    grade_rounds flows
    grade_rounds codex
    grade_selected
    ;;
esac

exit "$STATUS"
