#!/bin/sh
set -eu
b30_benchdir=$(cd -- "$(dirname -- "$0")" && pwd)
node --experimental-test-coverage --test-coverage-lines=100 --test-coverage-branches=100 --test-coverage-functions=100 \
  --test-coverage-include='**/cell-comparison/analysis.mjs' --test "$b30_benchdir/analysis.check.mjs"
node --import vibelang/register --test "$b30_benchdir/measure.check.mjs"
