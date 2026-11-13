#!/bin/bash
# Proves the sealed testbed against real docker, without spending a token.
#
#   ./network-dryrun.sh
#   ./network-dryrun.sh --offline   # ledger and preflight setup-failure fixtures only
#
# `fixtures/check-testbed-network.mjs` replays the ledger field and the
# scoreboard's assertion offline. What it cannot replay is the part that only
# exists when a daemon is real: whether a `--network none` container can be
# `docker exec`-ed into at all, whether it can reach the network anyway, and
# whether `docker inspect` reports back what the run asked for.
#
# That last question is the whole ruling. The codex arm's environment seal was a
# seal on the tools an agent reaches for, and two `r90s` runs got round it with a
# `docker exec <container> curl …` — the container kept its network, so the
# process the daemon started for that command was never covered. Will ruled on
# 2026-08-24: a proper sandbox, so it cannot cheat. This is where that claim is
# measured rather than asserted.
#
# Four phases:
#
#   A  the physical fact: a `--network none` container has `lo` and nothing
#      else, cannot resolve a name, cannot open a raw IP, and `docker exec`
#      works against it anyway — which it has to, because both arms run the
#      project's tests that way
#   B  the same measurement through `lib/testbed-network.sh`: `resolve` refuses
#      anything but the two values, `observe` reports the fact, and `assert`
#      fails a container that is on the wrong network
#   C  the preflight, driven end to end over tiny images through its two stub
#      hooks: a repository whose suite works without the network clears, one
#      whose suite needs it is flagged, one that fails under both is not a
#      network finding, and every probe flagged says SYSTEMIC and exits 2
#   D  the scoreboard's exit status over a ledger written by the same fields the
#      real runs write
#
# Real docker, one tiny image: `alpine` is pulled if absent and left behind,
# because it is the disk probe's image too.
#
# Spends no model tokens. Needs docker and about 8 MB of pulls.
set -eu
S="$(cd "$(dirname "$0")" && pwd)"
case "${1:-}" in
  ''|--offline) ;;
  *) echo "usage: network-dryrun.sh [--offline]" >&2; exit 2 ;;
esac
node "$S/fixtures/check-testbed-network.mjs"
if [ "${1:-}" = "--offline" ]; then exit 0; fi
TMP="$(mktemp -d "${TMPDIR:-/tmp}/flows-network-dryrun-XXXXXX")"
PASSED=0
SWB_NETWORK_OWNER="${TMP##*/}"
export SWB_NETWORK_OWNER
CONTAINER_PREFIX="swb-netdry-${SWB_NETWORK_OWNER}-"

cleanup() {
  LEFT="$(docker ps -aq --filter "name=^${CONTAINER_PREFIX}" 2>/dev/null || printf '')"
  if [ -n "$LEFT" ]; then docker rm -f $LEFT >/dev/null 2>&1 || true; fi
  LEFT="$(docker ps -aq --filter "name=^swb-preflight-${SWB_NETWORK_OWNER}-" 2>/dev/null || printf '')"
  if [ -n "$LEFT" ]; then docker rm -f $LEFT >/dev/null 2>&1 || true; fi
  if [ "${SWB_DRYRUN_KEEP:-0}" = "1" ]; then
    echo "dryrun: artifacts kept in $TMP"
  else
    rm -rf "$TMP"
  fi
}
trap cleanup EXIT

ok() { PASSED=$((PASSED + 1)); printf '  ok   %s\n' "$1"; }
bad() { printf '  FAIL %s\n' "$1"; exit 1; }

if ! docker image inspect alpine:3 >/dev/null 2>&1; then
  docker pull alpine:3 >/dev/null 2>&1 || { echo "dryrun: could not pull alpine:3"; exit 1; }
fi

# ---------------------------------------------------------------------------
# A  The physical fact.
# ---------------------------------------------------------------------------
echo "== A: what a --network none container can and cannot do"
docker run -d --name "${CONTAINER_PREFIX}none" --network none alpine:3 sleep 300 >/dev/null
docker run -d --name "${CONTAINER_PREFIX}bridge" --network bridge alpine:3 sleep 300 >/dev/null

# The one that has to work. `docker exec` attaches a process to an existing
# container's namespaces through the daemon's unix socket, so it needs no
# network of its own — and both arms are told to run the project's tests with
# it, so a condition that broke it would measure a harness with no way to check
# its work. That is what `SWB_CODEX_NETWORK=off` does, and why it is not the
# sealed lane.
if docker exec "${CONTAINER_PREFIX}none" sh -c 'exit 0'; then
  ok "docker exec works against a --network none container"
else
  bad "docker exec was refused by a --network none container"
fi
if [ "$(docker exec "${CONTAINER_PREFIX}none" sh -c 'echo alive')" = "alive" ]; then
  ok "docker exec carries stdout back out of it"
else
  bad "docker exec produced no output"
fi

# The interfaces the container has. `lo` and nothing else is the whole claim.
IFACES="$(docker exec "${CONTAINER_PREFIX}none" sh -c "ip -o link | awk -F': ' '{print \$2}'" | tr '\n' ' ')"
case "$IFACES" in
  'lo '|'lo') ok "the container has only lo (read: $IFACES)" ;;
  *) bad "the container has interfaces beyond lo: $IFACES" ;;
esac

# Egress, both ways an agent would try it. A name, and a raw IP for an agent
# that guessed DNS was the obstacle.
if docker exec "${CONTAINER_PREFIX}none" sh -c 'wget -T 3 -q -O- http://example.com/ >/dev/null 2>&1'; then
  bad "a --network none container resolved and fetched a name"
else
  ok "no DNS out of a --network none container"
fi
if docker exec "${CONTAINER_PREFIX}none" sh -c 'wget -T 3 -q -O- http://93.184.216.34/ >/dev/null 2>&1'; then
  bad "a --network none container reached a raw IP"
else
  ok "no route to a raw IP either — knowing the address does not help"
fi

# The breach itself, run the way the two `r90s` runs ran it. This is the
# command that fetched `pull/8721.patch` and `pull/19495.diff`.
if docker exec "${CONTAINER_PREFIX}none" sh -c \
  'wget -T 3 -q -O- https://github.com/sphinx-doc/sphinx/pull/8721.patch >/dev/null 2>&1'; then
  bad "the recorded breach command still works inside a sealed testbed"
else
  ok "the recorded breach command (fetching the upstream patch) fails inside a sealed testbed"
fi

# ---------------------------------------------------------------------------
# B  The same facts through the one file that knows the rule.
# ---------------------------------------------------------------------------
echo
echo "== B: lib/testbed-network.sh over live containers"
[ "$("$S/lib/testbed-network.sh" resolve)" = "none" ] \
  && ok "resolve defaults to none" || bad "resolve did not default to none"
[ "$(SWB_TESTBED_NETWORK=bridge "$S/lib/testbed-network.sh" resolve)" = "bridge" ] \
  && ok "resolve honours bridge" || bad "resolve refused bridge"
if SWB_TESTBED_NETWORK=host "$S/lib/testbed-network.sh" resolve >/dev/null 2>&1; then
  bad "resolve accepted a value that is not none or bridge"
else
  ok "resolve refuses anything but none and bridge"
fi
[ "$("$S/lib/testbed-network.sh" observe "${CONTAINER_PREFIX}none")" = "none" ] \
  && ok "observe reads none off the live container" || bad "observe misread the sealed container"
[ "$("$S/lib/testbed-network.sh" observe "${CONTAINER_PREFIX}bridge")" = "bridge" ] \
  && ok "observe reads bridge off the live container" || bad "observe misread the networked container"
"$S/lib/testbed-network.sh" assert "${CONTAINER_PREFIX}none" none >/dev/null \
  && ok "assert passes a container on the condition its lane asked for" \
  || bad "assert failed a correctly sealed container"
if "$S/lib/testbed-network.sh" assert "${CONTAINER_PREFIX}bridge" none >/dev/null 2>&1; then
  bad "assert passed a networked container as sealed"
else
  ok "assert fails a container on the wrong network — the run stops before a token is spent"
fi
if "$S/lib/testbed-network.sh" observe "${CONTAINER_PREFIX}absent" >/dev/null 2>&1; then
  bad "observe invented an answer for a container that does not exist"
else
  ok "observe refuses a container that does not exist"
fi
docker rm -f "${CONTAINER_PREFIX}none" "${CONTAINER_PREFIX}bridge" >/dev/null 2>&1 || true

# ---------------------------------------------------------------------------
# C  The preflight, end to end.
#
# The real script pulls multi-gigabyte official images and runs whole suites.
# Its two stub hooks replace exactly the two things that need them — which image
# an instance runs in, and what that repository's test command is — and
# everything between them is the code the preflight runs.
# ---------------------------------------------------------------------------
echo
echo "== C: preflight-network.sh over stub repositories"
cat > "$TMP/image.sh" <<'EOF'
#!/bin/sh
echo alpine:3
EOF
chmod +x "$TMP/image.sh"

# Three stub suites, one per outcome the classifier has to tell apart.
#
#   works   exits 0 under both conditions           -> ok
#   needs   fetches a name, so it fails only under none, and its output carries
#           the resolution error                    -> flagged
#   broken  exits 1 under both conditions, which is the normal case on an
#           untouched tree: the bug is present      -> ok, not a network finding
cat > "$TMP/testcmd.sh" <<'EOF'
#!/bin/sh
case "$1" in
  works__works-1)  echo "echo 'ran 3 tests'; exit 0" ;;
  needs__needs-1)  echo "wget -T 3 -q -O- http://example.com/ >/dev/null 2>&1 || { echo 'socket.gaierror: Temporary failure in name resolution'; exit 1; }" ;;
  broken__broken-1) echo "echo 'FAILED tests/test_thing.py::test_bug'; exit 1" ;;
  *) exit 1 ;;
esac
EOF
chmod +x "$TMP/testcmd.sh"

preflight() {
  SWB_PREFLIGHT_IMAGE_CMD="$TMP/image.sh" \
  SWB_PREFLIGHT_TEST_CMD="$TMP/testcmd.sh" \
  SWB_PREFLIGHT_LOGS="$TMP/logs" \
  SWB_PREFLIGHT_MANIFEST="$TMP/manifest.jsonl" \
  SWB_PREFLIGHT_TIMEOUT=30 \
  SWB_PREFLIGHT_SHELL=sh \
  SWB_PREFLIGHT_INSTANCES="$1" \
    "$S/preflight-network.sh" --report "$TMP/report.json" > "$TMP/preflight.log" 2>&1
}

# A population for the family counts, so a flagged probe can say how many scored
# instances it stands for.
node -e '
  const { writeFileSync } = require("fs")
  const at = Date.now()
  const rows = ["needs__needs-1", "needs__needs-2", "works__works-1", "broken__broken-1"].flatMap((id) => [
    { kind: "instance", id, state: "graded", at, verdict: "resolved" }
  ])
  writeFileSync(process.argv[1], rows.map((row) => JSON.stringify(row)).join("\n") + "\n")
' "$TMP/manifest.jsonl"

set +e
preflight "works__works-1 broken__broken-1"; CLEAR_STATUS=$?
set -e
[ "$CLEAR_STATUS" = "0" ] && ok "a suite that runs without the network, and one that fails for its own reasons, clear" \
  || { cat "$TMP/preflight.log"; bad "an all-clear preflight did not exit 0 (exit $CLEAR_STATUS)"; }
grep -q "broken__broken-1: ok" "$TMP/preflight.log" \
  && ok "a suite that fails under both conditions is not a network finding" \
  || { cat "$TMP/preflight.log"; bad "a pre-existing failure was reported as a network finding"; }

set +e
preflight "works__works-1 needs__needs-1"; MIXED_STATUS=$?
set -e
[ "$MIXED_STATUS" = "1" ] && ok "one flagged probe exits 1" \
  || { cat "$TMP/preflight.log"; bad "a flagged probe did not exit 1 (exit $MIXED_STATUS)"; }
grep -q "needs__needs-1: FLAGGED" "$TMP/preflight.log" \
  && ok "the suite that reaches the network is named" \
  || { cat "$TMP/preflight.log"; bad "the egress-dependent suite was not flagged"; }
grep -q "stands for 2 scored needs instances" "$TMP/preflight.log" \
  && ok "a flagged probe says how many scored instances its family holds" \
  || { cat "$TMP/preflight.log"; bad "a flagged probe did not name its family size"; }
node -e '
  const report = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"))
  if (report.flagged !== 1) throw new Error(`expected 1 flagged, got ${report.flagged}`)
  if (report.systemic !== false) throw new Error("one flagged probe is not systemic")
  if (report.instancesAtRisk !== 2) throw new Error(`expected 2 instances at risk, got ${report.instancesAtRisk}`)
  const flagged = report.rows.find((row) => row.verdict === "flagged")
  if (flagged.noneObserved !== "none") throw new Error("the none boot did not record its observed network")
  if (flagged.bridgeObserved !== "bridge") throw new Error("the bridge boot did not record its observed network")
' "$TMP/report.json" && ok "the JSON report carries the flag, the family size and both observed networks" \
  || bad "the JSON report is wrong"

set +e
preflight "needs__needs-1"; SYSTEMIC_STATUS=$?
set -e
[ "$SYSTEMIC_STATUS" = "2" ] && ok "every probe flagged exits 2" \
  || { cat "$TMP/preflight.log"; bad "a systemic preflight did not exit 2 (exit $SYSTEMIC_STATUS)"; }
grep -q "SYSTEMIC" "$TMP/preflight.log" \
  && ok "and says SYSTEMIC, loudly, with STOP" \
  || { cat "$TMP/preflight.log"; bad "a systemic preflight did not say so"; }
grep -q "STOP. Do not start a none lane." "$TMP/preflight.log" \
  && ok "the instruction is the ruling, not a suggestion" \
  || { cat "$TMP/preflight.log"; bad "the systemic banner did not say to stop"; }

# Coverage is stated, and stated before the verdict. Three probes do not speak
# for eight repository families, and an all-clear that read as coverage would be
# the same defect the `codex-sealed-websearch` lane was.
set +e
preflight "works__works-1 broken__broken-1"
set -e
grep -q "not probed: needs:2" "$TMP/preflight.log" \
  && ok "the families no probe reached are named with their instance counts" \
  || { cat "$TMP/preflight.log"; bad "an all-clear did not say what it left unprobed"; }

# ---------------------------------------------------------------------------
# D  The scoreboard's exit status, over the fields the real runs write.
# ---------------------------------------------------------------------------
echo
echo "== D: compare-codex-lanes.mjs asserts the seal rather than describing it"
node -e '
  const { writeFileSync } = require("fs")
  const [, dir] = process.argv
  const jsonl = (name, rows) =>
    writeFileSync(`${dir}/${name}`, rows.map((row) => JSON.stringify(row)).join("\n") + "\n")
  jsonl("manifest.jsonl", [
    { kind: "instance", id: "a__a-1", state: "graded", at: 1, verdict: "resolved" },
    { kind: "instance", id: "a__a-1", state: "cleaned", at: 2 }
  ])
  jsonl("net.jsonl", [{ kind: "instance", id: "a__a-1", state: "graded", at: 3, verdict: "resolved" }])
  jsonl("sealed.jsonl", [{
    kind: "instance", id: "a__a-1", state: "graded", at: 3, verdict: "resolved",
    testbedNetwork: "none", testbedNetworkObserved: "none"
  }])
  jsonl("leaky.jsonl", [{
    kind: "instance", id: "a__a-1", state: "graded", at: 3, verdict: "resolved",
    testbedNetwork: "none", testbedNetworkObserved: "bridge"
  }])
' "$TMP"
mkdir -p "$TMP/lanelogs"
printf "docker exec box bash -lc 'pytest -q'\n" > "$TMP/lanelogs/a__a-1.run.log"

lanes() {
  node "$S/compare-codex-lanes.mjs" --manifest "$TMP/manifest.jsonl" --net "$TMP/net.jsonl" \
    --sealed "$1" --logs "$TMP/lanelogs" --json "${@:2}" > "$TMP/lanes.json" 2>"$TMP/lanes.err"
}
set +e
lanes "$TMP/sealed.jsonl"; SEALED_STATUS=$?
lanes "$TMP/leaky.jsonl"; LEAKY_STATUS=$?
set -e
[ "$SEALED_STATUS" = "0" ] && ok "a lane whose containers were observed on none passes" \
  || { cat "$TMP/lanes.err"; bad "a correctly sealed lane failed"; }
[ "$LEAKY_STATUS" = "1" ] && ok "a lane with a networked container fails the process, not just the prose" \
  || bad "a networked container did not fail the lane (exit $LEAKY_STATUS)"
grep -q "not sealed" "$TMP/lanes.err" && ok "and says which container and what it was on" \
  || { cat "$TMP/lanes.err"; bad "the failure was not explained"; }

echo
node "$S/fixtures/check-network-isolation.mjs"

echo "network-dryrun: $PASSED assertions passed."
echo "  docker exec works against a --network none container, the recorded breach command does not,"
echo "  the rule is read back off the live container, the preflight tells an egress-dependent suite"
echo "  from a pre-existing failure and stops loudly when every probe fails, and a lane that claims"
echo "  the seal fails its process when any container was not on it."
