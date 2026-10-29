---
"@smthrs/build-cli": minor
---

`smthrs ci --fail-fast` (and every execution command) stops at the first failure that fails the run, as Bazel does without `--keep_going`: nothing new starts, running targets are interrupted and their process groups killed, and every unfinished target is reported `cancelled`. A failure `--known-red` or a non-blocking artifact lifecycle excuses does not stop the run; `KnownRed.blocks` is the one rule the stop and the verdict share. `Executor.scheduleEffect` accepts a `stop` option.
