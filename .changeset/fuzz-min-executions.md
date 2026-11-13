---
"@smthrs/fuzz": minor
---

`Fuzz.Options.minExecutions` is a floor under `duration` and `plateau`: a run continues until that many exploratory
executions have run, while `executions` and `maxFindings` still stop it. With a fixed `seed` those first executions are
the same on every machine, so a time-budgeted gate always covers them, however loaded its host is.
