#!/bin/bash
# box-replay.sh <repository URL> <commit> <commits> [replay flags]: the half of box-replay.mjs that runs in the box,
# in the upload, beside packs/ (the release tarballs). It installs them, clones the repository, replays it as a user
# without privileges, and leaves the results in out/.
set -u
url=$1 commit=$2 commits=$3; shift 3
out=$PWD/out
chown root:root . && chmod go-w . && mkdir -m 755 "$out" || exit 4
say() { echo "[box $(date -u +%T)] $*"; }
{ echo "cpus $(nproc)"; free -b | sed -n 2p; df -B1 / | tail -1; uname -r; } > "$out/box.txt" 2>&1
cat "$out/box.txt"
# Drain every byte even after a log is full, so a noisy command keeps its own exit status.
log_limit=$((64 * 1024 * 1024))
append_log() {
  local file="$out/$1" kept=0
  if [ -f "$file" ]; then kept=$(wc -c < "$file"); fi
  head -c "$((log_limit - kept))" >> "$file" && cat > /dev/null
}
logged() (
  set -o pipefail
  local file=$1
  shift
  "$@" 2>&1 | append_log "$file"
)
install_tools() {
  apt-get update -qq && DEBIAN_FRONTEND=noninteractive apt-get install -y -qq bubblewrap strace
}
if ! command -v bwrap >/dev/null || ! command -v strace >/dev/null; then
  logged setup.log install_tools || {
    say "could not install the replay jail and recorder"; exit 4;
  }
fi
useradd -m -s /bin/bash runner || exit 4
run() { runuser -u runner -- env -i HOME=/home/runner USER=runner LANG=C.UTF-8 PATH=/usr/local/bin:/usr/bin:/bin "$@"; }
logged setup.log run bwrap --ro-bind / / --dev /dev --proc /proc --unshare-all -- true || {
  say "the replay jail could not start for runner"; exit 4;
}
cp -r packs /home/runner/packs && mkdir -p /home/runner/inst && chown -R runner: /home/runner/packs /home/runner/inst || exit 4
run node -e '
const fs = require("fs"), packs = JSON.parse(fs.readFileSync("/home/runner/packs/manifest.json", "utf8"))
const spec = (entry) => "file:/home/runner/packs/" + entry.filename
const ci = packs.find((entry) => entry.name === "smithers-ci")
const overrides = Object.fromEntries(packs.filter((entry) => entry !== ci).map((entry) => [entry.name, spec(entry)]))
fs.writeFileSync("/home/runner/inst/package.json", JSON.stringify({ private: true, dependencies: { "smithers-ci": spec(ci) }, overrides }))' || exit 4
(cd /home/runner/inst && logged install.log run npm install --no-audit --no-fund) || { say "npm install failed"; exit 4; }
logged clone.log run git clone -q --filter=blob:none --no-checkout "$url" /home/runner/repo || { say "clone failed"; exit 3; }
cd /home/runner/repo || exit 3
branch=$(run git symbolic-ref --short refs/remotes/origin/HEAD 2>/dev/null); branch=${branch#origin/}
logged clone.log run git checkout -q -B "${branch:-main}" "$commit" || { say "no commit $commit"; exit 3; }
say "replay of ${branch:-main} at $(run git rev-parse --short=12 HEAD), --commits $commits $*"
start=$(date +%s)
run env SMITHERS_CI_REQUIRE_JAIL=1 /home/runner/inst/node_modules/.bin/smithers-ci replay --commits "$commits" --json --out /home/runner/report.html "$@" \
  > "$out/replay.json" 2> >(tee /dev/stderr | append_log replay.log)
code=$?
wait "$!"
echo "$code" > "$out/exit"; echo "$(($(date +%s) - start))" > "$out/wall-seconds"
say "replay exit $code after $(cat "$out/wall-seconds") s"
# Only runner opens files produced by the repository. The parent owns all result names.
copy_result() {
  run sh -c 'test -f "$1" && ! test -L "$1" && cat -- "$1"' sh "$1" > "$out/$2" || rm -f "$out/$2"
}
copy_result /home/runner/report.html report.html.txt
run /home/runner/inst/node_modules/.bin/smithers-ci apply 2>&1 | append_log replay.log
if [ "${PIPESTATUS[0]}" -eq 0 ]; then
  copy_result .smithers/ci/NOT-REPRODUCED.txt NOT-REPRODUCED.txt
fi
say "results:"; ls -la "$out"
exit "$code"
