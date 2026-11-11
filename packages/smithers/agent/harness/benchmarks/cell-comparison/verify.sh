#!/bin/sh
set -eu
b30_benchdir=$(cd -- "$(dirname -- "$0")" && pwd)
node --experimental-test-coverage --test-coverage-lines=100 --test-coverage-branches=100 --test-coverage-functions=100 \
  --test-coverage-include='**/cell-comparison/analysis.mjs' --test "$b30_benchdir/analysis.check.mjs"
node --import vibelang/register --test "$b30_benchdir/measure.check.mjs"
# The published campaign and the measured probes, recomputed from their raw receipts.
# probe-01 retains startup metadata only and has no receipts to verify.
b30_root=$(cd -- "$b30_benchdir" && pwd -P)
for b30_campaign in observed-2026-11-05 probe-02 probe-03; do
  node --import vibelang/register "$b30_root/verify.mjs" "$b30_root/$b30_campaign"
done
