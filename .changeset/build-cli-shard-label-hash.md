---
"@smthrs/build-cli": patch
---

`--shard <index>/<count>` now counts from 0 and takes the planned targets whose label hashes to `index` (32-bit FNV-1a,
the rule of the `smithers-ci` `Shard` contract), with their dependencies. `affected`, `build`, `test`, `lint` and
`docs` take it as well as `ci`, and a sharded run's summary and results file carry `shard`. `--timings` now weighs only
the `--remote` split.
