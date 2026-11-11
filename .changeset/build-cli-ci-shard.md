---
"@smthrs/build-cli": patch
---

`ci --shard <index>/<count>` runs one part of the selected roots, balanced by the durations of earlier runs named with
`--timings <results-file>` (repeatable). Machines that plan the same commit with the same timings agree on the split.
