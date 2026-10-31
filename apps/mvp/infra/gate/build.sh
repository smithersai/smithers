#!/bin/sh
# Builds the gate machine's image (Dockerfile) for COMMIT on a linux/amd64 host with podman or docker, after the branch
# sandbox's image it extends. Prints the tag: the first 16 hex digits of the commit's pnpm-lock.yaml digest.
# usage: infra/gate/build.sh <commit> [name]
set -eu
commit=$1 name=${2:-smithers-gate}
here=$(cd "$(dirname "$0")" && pwd)
engine=$(command -v podman || command -v docker)
"$engine" build --platform linux/amd64 -t smithers-sandbox:gate-base "$here/../sandbox" >&2
"$engine" build --platform linux/amd64 --build-arg SANDBOX_IMAGE=smithers-sandbox:gate-base --build-arg COMMIT="$commit" \
  -t "$name:build" "$here" >&2
# Cloudflare refuses a layer with more than 100,000 hard links: count them before anything is pushed.
links=$("$engine" run --rm --user 0 --entrypoint sh "$name:build" -c 'find / -xdev -type f -links +1 2>/dev/null | wc -l')
[ "$links" -lt 100000 ] || { echo "build.sh: $links hard-linked files; Cloudflare refuses over 100000" >&2; exit 3; }
tag=$("$engine" run --rm --entrypoint cat "$name:build" /etc/smithers-gate/lockfile.sha256 | cut -c1-16)
"$engine" tag "$name:build" "$name:$tag"
echo "$tag"
