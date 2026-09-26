#!/bin/bash
# Re-grades an already-collected patch, without re-running the agent.
#
#   ./regrade.sh --reason <text> <instance_id> [<instance_id> ...]
#   HARNESS=codex ./regrade.sh --reason <text> <instance_id> ...
#
# A verdict in `fullbench/manifest.jsonl` is a statement about a patch **and**
# about the rig that graded it. Two kinds of r90 verdict were statements about
# the rig alone:
#
# - four instances (12741, 13406, 15380, 22865) carry `eval error`. Their
#   `run_instance.log` records `docker.errors.ImageNotFound` from
#   `images.pull` — the image was gone between the pull call and the inspect
#   that follows it, on a host where the benchmark itself deletes an image the
#   moment its instance is graded. The agent's patch was never run.
# - `psf__requests-1766` and `psf__requests-2317` graded `unresolved` because
#   the public httpbin.org answered 503 to every network test in the suite,
#   including 34 and 22 `PASS_TO_PASS` tests. See `lib/httpbin.sh`.
#
# So this re-grades exactly those patches with the rig fixed. It is not a second
# attempt and cannot become one: it runs no agent, spends no tokens, reads only
# the patch already archived under `fullbench/patches/`, and refuses an instance
# that has no patch on disk.
#
# What it does per instance:
#
#   claim -> disk gate -> pull if absent -> archive the superseded verdict ->
#   grade -> record -> delete the image it pulled
#
# The superseded evaluator log directory is moved aside rather than deleted, to
# `<id>.superseded-<epoch>`, because the 503s in its `test_output.txt` are the
# evidence for the re-grade and a re-grade that destroys its own evidence is not
# one. The evaluator must not find a `report.json` for the instance under the run
# id or it skips it as already run — that is why the directory has to move.
#
# The new verdict is a fresh `graded` row appended to the ledger, carrying
# `regrade` (the reason) and `supersedes` (the verdict it replaces). The ledger
# stays append-only and the fold takes the last row, so the scoreboard reads the
# re-graded verdict while the row it replaced is still in the file.
#
#   HARNESS=flows|codex     which arm's patches and ledger (default flows)
#   SWB_REGRADE_MIN_FREE_MIB   the disk gate, in MiB (default 8192)
#   SWB_NO_HTTPBIN=1        grade psf/requests against the public service anyway
#
# Spends no tokens. Needs docker, and pulls one official image per instance whose
# image is not already local.
set -u
S="$(cd "$(dirname "$0")" && pwd)"
FB="${FB_DIR:-$S/fullbench}"
HARNESS="${HARNESS:-flows}"
MIN_FREE_MIB="${SWB_REGRADE_MIN_FREE_MIB:-8192}"
DISK_WAIT_MAX="${SWB_REGRADE_DISK_WAIT_MAX:-3600}"
DISK_INTERVAL="${SWB_REGRADE_DISK_INTERVAL:-60}"
EVAL_LOG_ROOT="${SWB_EVAL_LOG_ROOT:-$S/logs/run_evaluation}"

case "$HARNESS" in
  flows)
    MANIFEST="$FB/manifest.jsonl"
    PATCH_ROOT="$FB/patches"
    REPORT_ROOT="$FB/reports"
    CLAIM_ROOT="$FB/claims"
    EVAL_RUN_ID="${SWB_FULLBENCH_RUN_ID:-fullbench}"
    MODEL_NAME="${SWB_MODEL_NAME:-flows-cell-harness}"
    ;;
  codex)
    # The codex arm has lanes — one measurement of the population per condition —
    # and every one of them owns a ledger, an archive and an evaluator run id
    # together. `codex-backfill.sh` holds the table; this reads the same one, so
    # a re-grade cannot append a sealed verdict to the network lane's ledger or
    # grade a sealed patch under the network lane's run id.
    case "${SWB_CODEX_LANE:-net}" in
      net) LANE_DIRECTORY="codex"; LANE_LEDGER="codex-manifest.jsonl"; LANE_RUN_ID="fullbench-codex" ;;
      sealed) LANE_DIRECTORY="codex-sealed"; LANE_LEDGER="codex-sealed-manifest.jsonl"; LANE_RUN_ID="fullbench-codex-sealed" ;;
      *) echo "regrade.sh: unknown lane '${SWB_CODEX_LANE:-net}' — the lanes are net and sealed" >&2; exit 2 ;;
    esac
    MANIFEST="$FB/$LANE_LEDGER"
    PATCH_ROOT="$FB/$LANE_DIRECTORY/patches"
    REPORT_ROOT="$FB/$LANE_DIRECTORY/reports"
    CLAIM_ROOT="$FB/$LANE_DIRECTORY/claims"
    EVAL_RUN_ID="${SWB_CODEX_BACKFILL_RUN_ID:-$LANE_RUN_ID}"
    MODEL_NAME="${SWB_MODEL_NAME:-codex-cli}"
    ;;
  *) echo "regrade.sh: HARNESS must be flows or codex, got '$HARNESS'" >&2; exit 2 ;;
esac

REASON=""
IDS=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    --reason) REASON="${2:-}"; shift 2 || shift ;;
    -*) echo "regrade.sh: unknown argument '$1'" >&2; exit 2 ;;
    *) IDS="$IDS $1"; shift ;;
  esac
done
if [ -z "$REASON" ]; then
  echo "regrade.sh: --reason is required — a verdict that changed with no recorded reason is not evidence" >&2
  exit 2
fi
if [ -z "$IDS" ]; then
  echo "usage: ./regrade.sh --reason <text> <instance_id> [<instance_id> ...]" >&2
  exit 2
fi
if [ ! -f "$MANIFEST" ]; then
  echo "regrade.sh: no ledger at $MANIFEST" >&2; exit 1
fi

now_ms() { node -e 'process.stdout.write(String(Date.now()))'; }
log() { printf '%s [%s] %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "${1:-regrade}" "${2:-}"; }
append() { node "$S/lib/manifest-append.mjs" "$1" "$2"; }
row() { node "$S/lib/fullbench-row.mjs" "$@"; }

mkdir -p "$REPORT_ROOT" "$CLAIM_ROOT"

# The verdict this ledger currently holds for an instance, from the same fold
# the scoreboard reads — never from a grep of the last matching line.
current_verdict() {
  node --input-type=module -e '
    import { read } from "'"$S"'/lib/fullbench-manifest.mjs"
    const state = read(process.argv[1]).states.get(process.argv[2])
    process.stdout.write(state?.verdict ?? "")
  ' "$MANIFEST" "$1"
}

disk_gate() {
  WAITED=0
  while :; do
    FREE="$("$S/lib/disk-free.sh")"
    case "$FREE" in ''|*[!0-9]*) FREE=0 ;; esac
    if [ "$FREE" -ge "$MIN_FREE_MIB" ]; then return 0; fi
    log "$1" "disk gate: ${FREE} MiB free, need ${MIN_FREE_MIB} MiB — waiting ${DISK_INTERVAL}s (waited ${WAITED}s)"
    if [ "$WAITED" -ge "$DISK_WAIT_MAX" ]; then return 1; fi
    sleep "$DISK_INTERVAL"
    WAITED=$((WAITED + DISK_INTERVAL))
  done
}

FAILURES=0
for ID in $IDS; do
  PATCH="$PATCH_ROOT/$ID.patch"
  if [ ! -f "$PATCH" ]; then
    log "$ID" "REFUSED: no archived patch at $PATCH — there is nothing to re-grade"
    FAILURES=$((FAILURES + 1))
    continue
  fi
  if [ ! -s "$PATCH" ]; then
    log "$ID" "REFUSED: the archived patch is empty — 'empty patch' is a fact about the agent, not the rig"
    FAILURES=$((FAILURES + 1))
    continue
  fi

  CLAIM="$CLAIM_ROOT/$ID"
  if ! "$S/lib/lock.sh" acquire "$CLAIM" --owner $$ --timeout 0 --quiet \
    --label "regrade.sh $ID"; then
    log "$ID" "already claimed by live pid $("$S/lib/lock.sh" owner "$CLAIM") — refusing"
    FAILURES=$((FAILURES + 1))
    continue
  fi

  # The *other* arm's claim on the same instance, too. The two arms keep separate
  # claim roots because they run separate agents, but they share one docker image
  # per instance, and that is the thing a re-grade pulls and deletes. On
  # 2026-08-21 a re-grade and a codex backfill overlapped on
  # `django__django-13406` and `django__django-15380` and each deleted the
  # image the other was about to grade against — two `eval error` verdicts, no
  # patch at fault. So an instance a live worker in the other arm is holding is
  # refused rather than raced.
  # Every claim root but this one, because the codex arm has more than one lane
  # now and a sealed lane holds the same image a network lane or a flows worker
  # does.
  BUSY=""
  for OTHER_CLAIM in "$FB/claims/$ID" "$FB/codex/claims/$ID" "$FB/codex-sealed/claims/$ID"; do
    if [ "$OTHER_CLAIM" = "$CLAIM_ROOT/$ID" ]; then continue; fi
    OTHER_OWNER="$("$S/lib/lock.sh" owner "$OTHER_CLAIM" 2>/dev/null || printf '')"
    if [ -n "$OTHER_OWNER" ] && kill -0 "$OTHER_OWNER" 2>/dev/null; then
      BUSY="$OTHER_OWNER"
    fi
  done
  if [ -n "$BUSY" ]; then
    log "$ID" "another lane is running it right now (pid $BUSY) and shares its image — refusing"
    "$S/lib/lock.sh" release "$CLAIM" --owner $$ --quiet || true
    FAILURES=$((FAILURES + 1))
    continue
  fi

  BEFORE="$(current_verdict "$ID")"
  IMAGE_ID="$(printf '%s' "$ID" | sed 's/__/_1776_/')"
  IMAGE="swebench/sweb.eval.x86_64.${IMAGE_ID}:latest"

  KEEP_IMAGE=0
  if docker image inspect "$IMAGE" >/dev/null 2>&1; then
    KEEP_IMAGE=1
    PULLED=cached
    log "$ID" "image $IMAGE already local — it was here before this re-grade and stays"
  else
    if ! disk_gate "$ID"; then
      log "$ID" "disk gate timed out before the pull"
      "$S/lib/lock.sh" release "$CLAIM" --owner $$ --quiet || true
      FAILURES=$((FAILURES + 1))
      continue
    fi
    log "$ID" "pulling $IMAGE"
    if ! docker pull --platform linux/amd64 "$IMAGE" >/dev/null 2>&1; then
      log "$ID" "docker pull failed"
      "$S/lib/lock.sh" release "$CLAIM" --owner $$ --quiet || true
      FAILURES=$((FAILURES + 1))
      continue
    fi
    PULLED=pulled
  fi

  # The superseded evaluator log, moved aside. The evaluator skips any instance
  # that already has a `report.json` under the run id, so it has to move; and it
  # is the evidence for this re-grade, so it must not be deleted.
  EVAL_DIR="$EVAL_LOG_ROOT/$EVAL_RUN_ID/$MODEL_NAME/$ID"
  if [ -d "$EVAL_DIR" ]; then
    mv "$EVAL_DIR" "$EVAL_DIR.superseded-$(date -u +%s)"
  fi
  if [ -f "$REPORT_ROOT/$ID.json" ]; then
    cp "$REPORT_ROOT/$ID.json" "$REPORT_ROOT/$ID.superseded.json"
  fi

  if ! "$S/lib/lock.sh" acquire "$S/.grade-lock" --owner $$ --label "regrade.sh $ID" \
    --timeout "${SWB_GRADE_LOCK_TIMEOUT:-7200}"; then
    log "$ID" "another evaluator held the grade lock for too long"
    "$S/lib/lock.sh" release "$CLAIM" --owner $$ --quiet || true
    FAILURES=$((FAILURES + 1))
    continue
  fi

  # An absolute SWB_PATCHES, so an FB_DIR inside or outside the rig grades from
  # the archive the benchmark wrote.
  if ! ABS_PATCHES="$(cd "$PATCH_ROOT" && pwd)"; then
    "$S/lib/lock.sh" release "$S/.grade-lock" --owner $$ --quiet || true
    "$S/lib/lock.sh" release "$CLAIM" --owner $$ --quiet || true
    log "$ID" "no patches directory at $PATCH_ROOT"
    FAILURES=$((FAILURES + 1))
    continue
  fi
  # The image again, now that the grade lock is held. Whatever was running while
  # this call waited may have deleted it — the evaluator removes its own instance
  # image at `--cache_level env` — and grading against a missing image is the
  # `eval error` this whole script exists to undo.
  if ! docker image inspect "$IMAGE" >/dev/null 2>&1; then
    log "$ID" "the image disappeared while this call waited for the grade lock — re-pulling"
    if ! docker pull --platform linux/amd64 "$IMAGE" >/dev/null 2>&1; then
      "$S/lib/lock.sh" release "$S/.grade-lock" --owner $$ --quiet || true
      "$S/lib/lock.sh" release "$CLAIM" --owner $$ --quiet || true
      log "$ID" "docker pull failed"
      FAILURES=$((FAILURES + 1))
      continue
    fi
    # This call pulled it, so this call deletes it.
    KEEP_IMAGE=0
    PULLED=pulled
  fi
  # `instance` when the image was already local, so a re-grade never deletes an
  # image the rest of the rig was keeping; `env` when this call pulled it.
  if [ "$KEEP_IMAGE" = "1" ]; then CACHE_LEVEL=instance; else CACHE_LEVEL=env; fi
  log "$ID" "re-grading as $EVAL_RUN_ID (cache_level $CACHE_LEVEL)"
  mkdir -p "$FB/logs"
  HARNESS="$HARNESS" SWB_PATCHES="$ABS_PATCHES" SWB_MODEL_NAME="$MODEL_NAME" \
    SWB_CACHE_LEVEL="$CACHE_LEVEL" SWB_GRADE_LOCK_HELD=1 \
    "$S/evaluate.sh" "$EVAL_RUN_ID" "$ID" > "$FB/logs/$ID.regrade.log" 2>&1
  GRADE_STATUS=$?
  "$S/lib/lock.sh" release "$S/.grade-lock" --owner $$ --quiet || true

  REPORT="$EVAL_DIR/report.json"
  if [ -f "$REPORT" ]; then
    cp "$REPORT" "$REPORT_ROOT/$ID.json"
    VERDICT="$(node -e '
      const report = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"))
      const row = report[process.argv[2]]
      if (row === undefined) { process.stdout.write("eval error") }
      else { process.stdout.write(row.resolved === true ? "resolved" : "unresolved") }
    ' "$REPORT" "$ID")"
  else
    VERDICT="eval error"
    log "$ID" "the evaluator wrote no report (exit $GRADE_STATUS) — see fullbench/logs/$ID.regrade.log"
  fi

  IMAGE_STATE=kept
  if [ "$KEEP_IMAGE" != "1" ]; then
    docker rmi -f "$IMAGE" >/dev/null 2>&1 || true
    if docker image inspect "$IMAGE" >/dev/null 2>&1; then IMAGE_STATE=present; else IMAGE_STATE=deleted; fi
  fi

  append "$MANIFEST" "$(row --kind instance --id "$ID" --state graded --at "$(now_ms)" \
    --image "$IMAGE" --verdict "$VERDICT" --regrade "$REASON" \
    --supersedes "$BEFORE" --pull "$PULLED" --image-state "$IMAGE_STATE" \
    --run-id "$EVAL_RUN_ID" --harness "$HARNESS")"
  log "$ID" "verdict: $VERDICT (was: ${BEFORE:-none}) — image $IMAGE_STATE"

  "$S/lib/lock.sh" release "$CLAIM" --owner $$ --quiet || true
done

if [ "$FAILURES" -gt 0 ]; then
  log regrade "$FAILURES instance(s) did not re-grade"
  exit 1
fi
exit 0
