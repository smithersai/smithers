#!/bin/bash
# box-replay.sh <repository URL> <commit> <commits> [replay flags]: the half of box-replay.mjs that runs in the box,
# in the upload, beside packs/ (the release tarballs). It installs them, clones the repository, replays it as a user
# without privileges, and leaves the results in out/.
set -u
url=$1 commit=$2 commits=$3; shift 3
out=$PWD/out; mkdir -p "$out"
say() { echo "[box $(date -u +%T)] $*"; }
{ echo "cpus $(nproc)"; free -b | sed -n 2p; df -B1 / | tail -1; uname -r; } > "$out/box.txt" 2>&1
cat "$out/box.txt"
if (apt-get update -qq && DEBIAN_FRONTEND=noninteractive apt-get install -y -qq bubblewrap strace) > "$out/setup.log" 2>&1
then say "installed $(bwrap --version), $(strace -V | head -1)"; else say "bubblewrap and strace could not be installed"; fi
useradd -m -s /bin/bash runner
chown -R runner: "$out"
run() { runuser -u runner -- env -i HOME=/home/runner USER=runner LANG=C.UTF-8 PATH=/usr/local/bin:/usr/bin:/bin "$@"; }
say "bubblewrap for the user: $(run bwrap --ro-bind / / --dev /dev --proc /proc --unshare-all -- true 2>&1 && echo starts)"
cp -r packs /home/runner/packs && mkdir -p /home/runner/inst && chown -R runner: /home/runner/packs /home/runner/inst
run node -e '
const fs = require("fs"), packs = JSON.parse(fs.readFileSync("/home/runner/packs/manifest.json", "utf8"))
const spec = (entry) => "file:/home/runner/packs/" + entry.filename
const ci = packs.find((entry) => entry.name === "smithers-ci")
const overrides = Object.fromEntries(packs.filter((entry) => entry !== ci).map((entry) => [entry.name, spec(entry)]))
fs.writeFileSync("/home/runner/inst/package.json", JSON.stringify({ private: true, dependencies: { "smithers-ci": spec(ci) }, overrides }))'
(cd /home/runner/inst && run npm install --no-audit --no-fund) > "$out/install.log" 2>&1; say "npm install exit $?"
run git clone -q --filter=blob:none --no-checkout "$url" /home/runner/repo > "$out/clone.log" 2>&1; say "clone exit $?"
cd /home/runner/repo || exit 3
branch=$(run git symbolic-ref --short refs/remotes/origin/HEAD 2>/dev/null); branch=${branch#origin/}
run git checkout -q -B "${branch:-main}" "$commit" >> "$out/clone.log" 2>&1 || { say "no commit $commit"; exit 3; }
say "replay of ${branch:-main} at $(run git rev-parse --short=12 HEAD), --commits $commits $*"
start=$(date +%s)
run /home/runner/inst/node_modules/.bin/smithers-ci replay --commits "$commits" --json --out "$out/report.html" "$@" \
  > "$out/replay.json" 2> >(tee "$out/replay.log" >&2)
code=$?
wait
echo "$code" > "$out/exit"; echo "$(($(date +%s) - start))" > "$out/wall-seconds"
say "replay exit $code after $(cat "$out/wall-seconds") s"
run /home/runner/inst/node_modules/.bin/smithers-ci apply >> "$out/replay.log" 2>&1 &&
  cp .smithers/ci/NOT-REPRODUCED.txt "$out/" 2>/dev/null
say "results:"; ls -la "$out"
exit "$code"
