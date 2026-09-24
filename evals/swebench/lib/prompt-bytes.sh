#!/bin/bash
# What a wave's prompts actually weighed, per instance.
#
#   lib/prompt-bytes.sh <driver.log> [index]
#
# The cell contract is one prefix segment and its size is pinned by a unit test.
# The task prompt is not: `lib/write-flow.mjs` renders it out of the dataset row,
# the repository's own test command, and — since the r91 surgery — the project
# interpreter measured off the container. Those three vary per instance, so the
# only honest answer to "how big was the prompt in this wave" is to render the
# prompt each instance was actually given.
#
# Which is what this does. The interpreter is read back out of the driver log the
# wave wrote, so this reports the fact the wave really stated rather than the
# fact a re-measurement would state today; the container it names is the one
# `lib/run-paths.sh` derives, so the rendered bytes are the bytes that were sent.
# The index defaults to the one the log's own run ids carry.
#
# Prints one TSV row per instance — id, prompt bytes, interpreter — and a
# summary line. Spends no tokens, needs no docker: the containers are long gone
# and nothing here talks to one.
set -euo pipefail
S="$(cd "$(dirname "$0")/.." && pwd)"
LOG="${1:-}"
if [ -z "$LOG" ] || [ ! -f "$LOG" ]; then
  echo "prompt-bytes.sh: pass the wave's driver.log" >&2
  exit 2
fi
DATASET="${SWB_DATASET:-$S/swb-verified.json}"
SEAT="${SWB_SEAT:-openai:gpt-6-sol}"
PY="$S/.venv-swb/bin/python"
if [ ! -x "$PY" ]; then
  echo "prompt-bytes.sh: no evaluator venv at $PY — run ./bootstrap.sh first" >&2
  exit 1
fi

TOTAL=0
COUNT=0
# `project interpreter <path>` is written once per instance, before the agent
# starts. A container that answered nothing usable logged the other sentence and
# is rendered here the same way the wave rendered it: without the bullet.
while IFS= read -r LINE; do
  RUN_ID="${LINE%%]*}"
  RUN_ID="${RUN_ID#[}"
  INSTANCE="${RUN_ID%-*}"
  INDEX="${2:-${RUN_ID##*-}}"
  INTERPRETER="${LINE##* }"
  case "$INTERPRETER" in
    /*) ;;
    *) INTERPRETER="" ;;
  esac
  eval "$("$S/lib/run-paths.sh" flows "$INSTANCE" "$INDEX")"
  TEST_CMD="$("$PY" "$S/lib/test-command.py" "$DATASET" "$INSTANCE")"
  BYTES="$(node "$S/lib/write-flow.mjs" "$DATASET" "$INSTANCE" "$SEAT" "$CONTAINER" "$TEST_CMD" "$INTERPRETER" | wc -c | tr -d ' ')"
  printf '%s\t%s\t%s\n' "$INSTANCE" "$BYTES" "${INTERPRETER:-none}"
  TOTAL=$((TOTAL + BYTES))
  COUNT=$((COUNT + 1))
done < <(grep -E '^\[[^]]+\] project interpreter ' "$LOG" || true)

if [ "$COUNT" -eq 0 ]; then
  echo "prompt-bytes.sh: $LOG records no project interpreter line" >&2
  exit 1
fi
printf 'instances\t%s\ttotal\t%s\tmean\t%s\n' "$COUNT" "$TOTAL" "$((TOTAL / COUNT))"
