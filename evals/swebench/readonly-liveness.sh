#!/bin/bash
# Proves the read-only cap's demand reaches a journal through the real CLI.
#
#   ./readonly-liveness.sh [seat]
#
# THIS SPENDS MODEL TOKENS. It is the cheapest end-to-end proof the CLI admits:
# the harness has no scripted seat reachable from the command line — the Node
# seat resolver builds every seat from a provider API key and a hard-coded
# origin — so the only way to run the real composition is to run a real model.
# The probe is sized to the cap and nothing more: `readOnlyCap` frames that read
# one small file, plus the frame that receives the demand. At the committed
# `prices.ts` rates that has cost tens of cents per run; the exact figure is
# printed at the end from the run's own journal.
#
# What it proves, and why the rig needs it: waves 5 and 6 armed the cap on every
# run (`readOnlyCap: 12`, journaled) and produced zero
# `control.agent.read-only-demanded` events, while the harness's own unit tests
# showed the control firing. Only a run through the CLI can tell a dead control
# apart from a live one that nothing asked to act. This is that run, and it is
# cheap enough to repeat whenever the harness or the CLI composition changes.
#
# Needs `./preflight.sh` to have pinned a subject, and OPENAI_API_KEY (or the
# key for whatever seat is passed) in the environment. Needs no docker and no
# dataset.
set -eu
S="$(cd "$(dirname "$0")" && pwd)"
SEAT="${1:-openai:gpt-6-sol}"
WORK="$S/work-liveness"
CAP="${SWB_READ_ONLY_CAP:-12}"

[ -f "$S/.subject.json" ] || { echo "readonly-liveness.sh: no subject pinned; run ./preflight.sh" >&2; exit 1; }

rm -rf -- "$WORK"
mkdir -p "$WORK/flows/probe"
# One small file for the probe to read every frame. Its content is fixed so the
# frames differ only in their counter, which keeps the transcript short and the
# cost near its floor.
cat > "$WORK/NOTES.md" <<'NOTES'
# Notes

This file exists to be read. It is never edited.
NOTES
node "$S/lib/liveness-flow.mjs" "$SEAT" "$CAP" > "$WORK/flows/probe/flow.mdx"

echo "== subject"
node -e '
  const pinned = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
  console.log("   " + pinned.stamp);
  console.log("   CellTurn.ts " + pinned.marker.hash);
  console.log("   loaded from " + pinned.marker.resolvedBy);
' "$S/.subject.json"

echo "== running the probe ($SEAT, cap $CAP)"
(
  cd "$WORK" || exit 1
  A=$("$S/flows.sh" --json plan probe | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{console.log(JSON.stringify(JSON.parse(s).approval))}catch{process.exit(1)}})') || exit 1
  "$S/flows.sh" --json approve "$A" --scope run >/dev/null || exit 1
  "$S/flows.sh" --json run "$A"
) > "$WORK/probe.log" 2>&1 || echo "   (the run exited non-zero; the journal is still the evidence)"

echo "== journal"
node "$S/lib/check-liveness.mjs" "$WORK"
