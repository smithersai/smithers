---
"@smthrs/cli": minor
---

`smthrs triggers serve` now runs the schedules a `PACKAGE.ts` declares with `S.Cron`. The host registers each `S.Cron` target as a trigger under its label and runs the declared targets through the build when an occurrence is due, with no plan to approve. `smthrs triggers sync` registers changed declarations without a restart, and `smthrs triggers show` reports the active build run under `activeTargetRun`. A trigger registered by hand runs targets with the reserved flow `system/target-run` and `{"run":["//label"]}` as input.
