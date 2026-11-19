#!/bin/sh
# Smithers build, and then what a build in a jail leaves where it keeps its machines. It sets the machines of a
# run aside and removes them with a command nobody waits for; the jail ends that command with the build. What it
# had not reached stays: here a directory nothing can be removed from, as Go's module cache is.
# Usage: smthrs-left.sh <node> <smithers.mjs> [smthrs arguments]
node=$1
smthrs=$2
shift 2
"$node" "$smthrs" "$@"
code=$?
left="$SMTHRS_MACHINES/0000000000000000.gone-2-0badc0de/build-00000000/home/go/pkg/mod"
mkdir -p "$left/cache/download" && chmod -R a-w "$left"
exit $code
