#!/bin/bash
# Does a `--network none` testbed still let the repositories run their tests?
#
#   ./preflight-network.sh                     # three probes, no tokens
#   ./preflight-network.sh --report out.json   # the same, plus the row set as JSON
#
# `SWB_TESTBED_NETWORK=none` takes the network away from the container the agent
# runs the project's tests in. That is the point — two `r90s` runs fetched the
# merged upstream fix with a `docker exec <container> curl …`, and a container
# with no route cannot — but it changes what the *agent* can run, so it is
# validated before a lane spends a token rather than explained after one.
#
# The concern is narrow and specific: **a test or a `conftest.py` that reaches
# the network at agent-side run time.** Such a test fails under `none` for a
# reason that has nothing to do with the agent, and an instance whose suite
# cannot run is not a measurement of a harness. `psf__requests-1766` and
# `psf__requests-2317` are already excluded by name for the grading-side version
# of this — they need an httpbin route — so the class is known to be non-empty.
#
# **The evaluator's own grading containers are untouched by any of this.**
# Grading was never the hole: the evaluator runs the graded tests itself, after
# the agent is gone, against a patch. Moving its network would change what a
# verdict means, for every lane ever recorded. This script reads the agent-side
# condition and nothing else.
#
# ## What a probe is
#
# Three pinned, representative instances — one django, one sympy, one astropy —
# booted twice each: once under `--network none`, once under `bridge`. Each boot
# runs that repository's own test command, from the same `lib/test-command.py`
# both prompts are written from, on the **untouched** tree the official image
# ships at the base commit.
#
# The tree is untouched on purpose. The bug is present, so the suite is expected
# to fail, and an exit code on its own says nothing about the network. What the
# probe reads is the **pair**:
#
#   boot/assertion failed or network unverified     inconclusive  no suite comparison established
#   both the same                                  ok       the network is irrelevant here
#   none carries a resolution/connection error      flagged  the suite reaches the network
#     that bridge does not
#   none fails where bridge passes                  flagged  the same finding off the exit status
#   none passes where bridge fails                  noisy    reported, never a network finding
#   both fail the same way                          ok       a pre-existing failure, the normal case
#
# A flagged probe names every scored instance in its repository family, because
# one probe stands for all of them. **Every probe flagged is `SYSTEMIC`**: it
# exits 2 and says so at the top, because a testbed no repository's suite can
# run is a condition to abandon rather than a sandbox to tighten, and finding
# that out is the whole reason this runs first. One flagged probe exits 1. All
# clear exits 0. Any inconclusive probe exits 2 and is excluded from coverage.
#
# **Three probes do not cover eight families, and the report says which ones it
# did not reach rather than letting an all-clear read as coverage.** The scored
# 43 come from astropy, django, matplotlib, psf, pydata, pytest-dev, sphinx-doc
# and sympy; three probes are the sample Will asked for, on the reasoning that a
# `conftest.py` reaching the network is a property of a repository rather than
# of an instance. The uncovered families are printed with their instance counts
# under "not probed", so the number of instances an all-clear actually speaks
# for is on the same screen as the all-clear. `SWB_PREFLIGHT_INSTANCES` widens
# the sample when the answer matters more than the wall clock.
#
# Spends no model tokens. Needs docker and the three images (multi-gigabyte, and
# pulled if absent). `./network-dryrun.sh` drives this script over tiny images
# through `SWB_PREFLIGHT_IMAGE_CMD` and `SWB_PREFLIGHT_TEST_CMD`.
set -uo pipefail
S="$(cd "$(dirname "$0")" && pwd)"

# The three probes. Pinned by name rather than sampled, because a probe that
# moved between runs would make two preflights incomparable — and because the
# claim being made is about a repository family, so which member stands for it
# only has to be stable.
DEFAULT_INSTANCES="django__django-16612 sympy__sympy-20154 astropy__astropy-14365"
INSTANCES="${SWB_PREFLIGHT_INSTANCES:-$DEFAULT_INSTANCES}"
TIMEOUT="${SWB_PREFLIGHT_TIMEOUT:-900}"
# The shell the test command is handed to inside the container. The official
# images are debian and ship bash, and both prompts tell both arms to run their
# tests with `docker exec <container> bash -lc …`, so `bash` is what a probe has
# to reproduce. It is a knob only so `./network-dryrun.sh` can drive this script
# over a busybox image, which has `sh` and not `bash`.
SHELL_NAME="${SWB_PREFLIGHT_SHELL:-bash}"
DATASET="${SWB_DATASET:-$S/swb-verified.json}"
MANIFEST="${SWB_PREFLIGHT_MANIFEST:-$S/fullbench/manifest.jsonl}"
LOGS="${SWB_PREFLIGHT_LOGS:-$S/logs-preflight}"
REPORT=""

while [ "$#" -gt 0 ]; do
  case "$1" in
    --report) REPORT="${2:-}"; shift 2 || shift ;;
    --instances) INSTANCES="${2:-}"; shift 2 || shift ;;
    *) echo "preflight-network.sh: unknown argument '$1'"; exit 2 ;;
  esac
done

case "$TIMEOUT" in
  ''|*[!0-9]*|0) echo "preflight-network.sh: SWB_PREFLIGHT_TIMEOUT must be a positive integer, got '$TIMEOUT'"; exit 2 ;;
esac
case "$SHELL_NAME" in
  bash|sh) ;;
  *) echo "preflight-network.sh: SWB_PREFLIGHT_SHELL must be bash or sh, got '$SHELL_NAME'"; exit 2 ;;
esac

for REQUIRED_TOOL in docker node python3; do
  command -v "$REQUIRED_TOOL" >/dev/null 2>&1 || {
    echo "preflight-network.sh: required tool not found: $REQUIRED_TOOL" >&2
    exit 2
  }
done
case "${SWB_NETWORK_OWNER:-}" in
  *[!a-zA-Z0-9-]*) echo "preflight-network.sh: invalid network owner" >&2; exit 2 ;;
esac
INVOCATION="$(python3 -c 'import uuid; print(uuid.uuid4().hex)')" || exit 2
CONTAINER_PREFIX="swb-preflight-${SWB_NETWORK_OWNER:+${SWB_NETWORK_OWNER}-}${INVOCATION}-"
LOGS="$LOGS/$INVOCATION"
mkdir -p "$LOGS"

# The evidence that a failure is a *network* failure. These are the strings a
# python test suite produces when a name will not resolve or a socket will not
# open, and they are matched in the `none` run's output and looked for in the
# `bridge` run's. A signature in both is not a finding: it is a suite that logs
# a connection error under either condition, which is a fact about the suite.
EGRESS_SIGNATURES='Temporary failure in name resolution|Name or service not known|nodename nor servname|Network is unreachable|No route to host|Connection refused|Max retries exceeded|socket\.gaierror|gaierror|urlopen error|URLError|ConnectionError|ConnectTimeout|NewConnectionError|getaddrinfo|Could not resolve host|Failed to connect'

log() { printf '[preflight-network] %s\n' "$1"; }

# Each invocation owns a unique prefix, including probes started in a subshell.
# A dry run supplies its own outer owner so it can also clean up its children.
cleanup() {
  LEFT="$(docker ps -aq --filter "name=^${CONTAINER_PREFIX}" 2>/dev/null || printf '')"
  if [ -n "$LEFT" ]; then docker rm -f $LEFT >/dev/null 2>&1 || true; fi
}
trap cleanup EXIT INT TERM

# The image for an instance. The default is the official one; the stub hook is
# what lets the dry run drive this whole script over `alpine`.
image_for() {
  if [ -n "${SWB_PREFLIGHT_IMAGE_CMD:-}" ]; then
    "$SWB_PREFLIGHT_IMAGE_CMD" "$1"
    return $?
  fi
  IMAGE_ID="$(printf '%s' "$1" | sed 's/__/_1776_/')"
  printf 'swebench/sweb.eval.x86_64.%s:latest\n' "$IMAGE_ID"
}

# The repository's own test command, from the same place both prompts read it.
# Not `python -m pytest`: Django ships no pytest module and Sphinx runs under
# tox, so a probe that prescribed one runner for every repo would be measuring
# its own wrong command rather than the network.
test_command_for() {
  if [ -n "${SWB_PREFLIGHT_TEST_CMD:-}" ]; then
    "$SWB_PREFLIGHT_TEST_CMD" "$1"
    return $?
  fi
  "$S/.venv-swb/bin/python" "$S/lib/test-command.py" "$DATASET" "$1"
}

# One boot: start the container on one network, prove with `docker inspect` that
# it is on that network, and run the suite inside it. The proof is not optional
# — a probe that believed its own `--network` flag would report a `bridge` run
# as a `none` result and clear a condition that was never tested.
probe_once() {
  PROBE_ID="$1"; PROBE_IMAGE="$2"; PROBE_CMD="$3"; PROBE_NET="$4"; PROBE_LOG="$5"
  SLUG="$(printf '%s' "$PROBE_ID" | tr '_.' '--')"
  NAME="${CONTAINER_PREFIX}${SLUG}-${PROBE_NET}"
  if ! docker run -d --platform linux/amd64 --name "$NAME" --network "$PROBE_NET" \
    -w /testbed "$PROBE_IMAGE" sleep infinity >/dev/null 2>&1; then
    printf 'container start failed\n' > "$PROBE_LOG"
    printf '255 unknown\n'
    return 0
  fi
  OBSERVED="$("$S/lib/testbed-network.sh" assert "$NAME" "$PROBE_NET" 2>>"$PROBE_LOG")" || {
    printf 'testbed network mismatch: asked for %s\n' "$PROBE_NET" >> "$PROBE_LOG"
    docker rm -f "$NAME" >/dev/null 2>&1 || true
    printf '254 unknown\n'
    return 0
  }
  python3 "$S/lib/run-with-timeout.py" "$TIMEOUT" docker exec -w /testbed "$NAME" "$SHELL_NAME" -lc "$PROBE_CMD" > "$PROBE_LOG" 2>&1
  STATUS=$?
  docker rm -f "$NAME" >/dev/null 2>&1 || true
  printf '%s %s\n' "$STATUS" "$OBSERVED"
}

has_egress_signature() {
  grep -Eq "$EGRESS_SIGNATURES" "$1" 2>/dev/null
}

# The scored population, by repository family. The population is the full
# benchmark's ledger minus `lib/excluded.mjs`, which is the same 43 every rate
# in this rig is quoted over. `--family <name>` counts one; `--uncovered <list>`
# names the families no probe reached, so an all-clear cannot read as coverage
# it does not have.
families() {
  node --input-type=module -e '
    import { readFileSync } from "node:fs"
    import { isExcluded } from "'"$S"'/lib/excluded.mjs"
    const [, manifestPath, mode, argument] = process.argv
    let text = ""
    try { text = readFileSync(manifestPath, "utf8") } catch { text = "" }
    const counts = new Map()
    const seen = new Set()
    for (const line of text.split("\n")) {
      if (line.trim() === "") continue
      let row
      try { row = JSON.parse(line) } catch { continue }
      if (row.kind !== "instance" || typeof row.id !== "string") continue
      if (isExcluded(row.id) || seen.has(row.id)) continue
      seen.add(row.id)
      const family = row.id.split("__")[0]
      counts.set(family, (counts.get(family) ?? 0) + 1)
    }
    if (mode === "--family") {
      process.stdout.write(String(counts.get(argument) ?? 0))
    } else if (counts.size === 0) {
      // No population to read. "Nothing left to probe" and "no ledger" are
      // different answers and the caller is told which it got.
      process.stdout.write("unknown")
    } else {
      const probed = new Set((argument ?? "").split(" ").filter((name) => name !== ""))
      const left = [...counts.entries()].filter(([family]) => !probed.has(family)).sort()
      process.stdout.write(left.map(([family, count]) => `${family}:${count}`).join(" "))
    }
  ' "$MANIFEST" "$1" "${2:-}" 2>/dev/null || printf ''
}

ROWS=""
FLAGGED=0
NOISY=0
INCONCLUSIVE=0
TOTAL=0
PROBED_FAMILIES=""

log "probes: $INSTANCES"
log "each boots twice — --network none and --network bridge — and runs the repo's own suite on an untouched tree"
log "the evaluator's grading containers are not touched; grading was never the hole"
echo

for ID in $INSTANCES; do
  TOTAL=$((TOTAL + 1))
  FAMILY="${ID%%__*}"
  IMAGE="$(image_for "$ID")" || { log "$ID: no image; probe skipped"; continue; }
  CMD="$(test_command_for "$ID")" || { log "$ID: no test command — run ./bootstrap.sh first"; exit 2; }

  if ! docker image inspect "$IMAGE" >/dev/null 2>&1; then
    log "$ID: pulling $IMAGE"
    if ! docker pull --platform linux/amd64 "$IMAGE" >"$LOGS/$ID.pull.log" 2>&1; then
      log "$ID: PULL FAILED — see $LOGS/$ID.pull.log"
      exit 2
    fi
  fi

  log "$ID: $CMD"
  NONE_LOG="$LOGS/$ID.none.log"
  NET_LOG="$LOGS/$ID.bridge.log"
  # Two values out of one call, split on purpose: `probe_once` prints the exit
  # status and the network `docker inspect` reported, in that order, and both
  # are bare words by construction. `run-45.sh` reads its queue counts the same
  # way.
  # shellcheck disable=SC2046
  set -- $(probe_once "$ID" "$IMAGE" "$CMD" none "$NONE_LOG"); NONE_STATUS="$1"; NONE_SEEN="$2"
  # shellcheck disable=SC2046
  set -- $(probe_once "$ID" "$IMAGE" "$CMD" bridge "$NET_LOG"); NET_STATUS="$1"; NET_SEEN="$2"

  NONE_EGRESS=0; if has_egress_signature "$NONE_LOG"; then NONE_EGRESS=1; fi
  NET_EGRESS=0; if has_egress_signature "$NET_LOG"; then NET_EGRESS=1; fi

  # Setup sentinels are not suite results. Both conditions must be established
  # before either their exit statuses or their network-error logs can be read
  # as a comparison. Equal genuine suite failures still clear below.
  if [ "$NONE_STATUS" = "126" ] || [ "$NET_STATUS" = "126" ] \
    || [ "$NONE_STATUS" = "127" ] || [ "$NET_STATUS" = "127" ]; then
    VERDICT=inconclusive
    WHY="suite command could not be launched (exit $NONE_STATUS and $NET_STATUS)"
  elif [ "$NONE_STATUS" = "255" ] || [ "$NET_STATUS" = "255" ] \
    || [ "$NONE_STATUS" = "254" ] || [ "$NET_STATUS" = "254" ]; then
    VERDICT=inconclusive
    WHY="container start or network assertion failed (exit $NONE_STATUS and $NET_STATUS)"
  elif [ "$NONE_SEEN" != "none" ] || [ "$NET_SEEN" != "bridge" ]; then
    VERDICT=inconclusive
    WHY="network conditions were not established (observed '$NONE_SEEN' and '$NET_SEEN')"
  # A timeout under both conditions is a slow suite, not a network finding.
  elif [ "$NONE_STATUS" = "124" ] && [ "$NET_STATUS" = "124" ]; then
    VERDICT=ok
    WHY="the suite exceeded ${TIMEOUT}s under both conditions"
  elif [ "$NONE_EGRESS" = "1" ] && [ "$NET_EGRESS" = "0" ]; then
    VERDICT=flagged
    WHY="the none run carries a network error the bridge run does not"
  elif [ "$NONE_STATUS" != "$NET_STATUS" ] && [ "$NET_STATUS" = "0" ]; then
    VERDICT=flagged
    WHY="the suite passes with the network and fails without it"
  elif [ "$NONE_STATUS" = "0" ] && [ "$NET_STATUS" != "0" ]; then
    VERDICT=noisy
    WHY="the suite passes without the network and fails with it"
  else
    VERDICT=ok
    WHY="both conditions produced the same outcome (exit $NONE_STATUS and $NET_STATUS)"
  fi

  SIZE="$(families --family "$FAMILY")"
  if [ "$VERDICT" != "inconclusive" ]; then
    PROBED_FAMILIES="$PROBED_FAMILIES $FAMILY"
  fi
  case "$VERDICT" in
    inconclusive)
      INCONCLUSIVE=$((INCONCLUSIVE + 1))
      log "$ID: inconclusive — $WHY" ;;
    flagged)
      FLAGGED=$((FLAGGED + 1))
      log "$ID: FLAGGED — $WHY (stands for $SIZE scored $FAMILY instances)" ;;
    noisy)
      NOISY=$((NOISY + 1))
      log "$ID: noisy — $WHY" ;;
    *)
      log "$ID: ok — $WHY" ;;
  esac
  log "  none: exit $NONE_STATUS on '$NONE_SEEN', log $NONE_LOG"
  log "  bridge: exit $NET_STATUS on '$NET_SEEN', log $NET_LOG"
  echo

  ROWS="$ROWS$(node "$S/lib/fullbench-row.mjs" --id "$ID" --family "$FAMILY" \
    --verdict "$VERDICT" --why "$WHY" --familySize "$SIZE" \
    --noneExit "$NONE_STATUS" --noneObserved "$NONE_SEEN" --noneEgress "$NONE_EGRESS" \
    --bridgeExit "$NET_STATUS" --bridgeObserved "$NET_SEEN" --bridgeEgress "$NET_EGRESS" \
    --timeoutSeconds "$TIMEOUT")
"
done

if [ -n "$REPORT" ]; then
  printf '%s' "$ROWS" | node -e '
    let text = ""
    process.stdin.on("data", (chunk) => { text += chunk }).on("end", () => {
      const rows = text.split("\n").filter((line) => line.trim() !== "").map((line) => JSON.parse(line))
      const flagged = rows.filter((row) => row.verdict === "flagged")
      const inconclusive = rows.filter((row) => row.verdict === "inconclusive")
      require("fs").writeFileSync(process.argv[1], JSON.stringify({
        probes: rows.length - inconclusive.length,
        inconclusive: inconclusive.length,
        flagged: flagged.length,
        systemic: rows.length > 0 && flagged.length === rows.length,
        instancesAtRisk: flagged.reduce((total, row) => total + row.familySize, 0),
        rows
      }, undefined, 2) + "\n")
    })
  ' "$REPORT"
  log "report written to $REPORT"
fi

echo
# What the probes did not reach. Printed before the verdict, never after: an
# all-clear over three families is an all-clear over three families, and a
# reader who sees the coverage line second has already read the headline.
UNCOVERED="$(families --uncovered "$PROBED_FAMILIES")"
case "$UNCOVERED" in
  '')
    log "every scored repository family was probed" ;;
  unknown)
    log "coverage unknown: no scored population at $MANIFEST, so nothing says what these probes stand for" ;;
  *)
    log "not probed: $UNCOVERED — a handful of probes does not speak for every repository family"
    log "widen the sample with SWB_PREFLIGHT_INSTANCES when the answer matters more than the wall clock" ;;
esac

if [ "$TOTAL" = "0" ]; then
  log "no probes ran"
  exit 2
fi
if [ "$INCONCLUSIVE" -gt 0 ]; then
  log "$INCONCLUSIVE of $TOTAL probes inconclusive; repair container setup or network inspection and rerun the preflight"
  exit 2
fi
if [ "$FLAGGED" = "$TOTAL" ]; then
  echo "================================================================"
  echo "  SYSTEMIC: every probe failed under --network none."
  echo
  echo "  All $TOTAL representative repositories need the network to run"
  echo "  their own suites on an untouched tree. A --network none testbed"
  echo "  does not measure a harness under these conditions, it measures"
  echo "  the absence of a suite. STOP. Do not start a none lane."
  echo "================================================================"
  exit 2
fi
if [ "$FLAGGED" -gt 0 ]; then
  log "$FLAGGED of $TOTAL probes flagged; those repository families are not measurable under --network none"
  log "exclude them by name in lib/excluded.mjs, or run their lane on bridge and say so"
  exit 1
fi
if [ "$NOISY" -gt 0 ]; then
  log "$TOTAL of $TOTAL probes clear, $NOISY noisy — a --network none testbed runs these suites"
else
  log "$TOTAL of $TOTAL probes clear — a --network none testbed runs these suites"
fi
exit 0
