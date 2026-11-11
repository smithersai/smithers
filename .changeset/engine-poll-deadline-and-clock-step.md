---
"@smthrs/engine": patch
---

On the memory engine, a follower's elapsed poll re-drives a parked run unless the parked round awaits one of its timers.
A flow with a `deadline` whose action parked with `Flow.suspend` used to wait out the whole deadline, because the
deadline's clock counted as the timer the run was parked on. A wall clock stepped back past the start of a retry or
poll sequence now reads as no time spent, so a policy without `maxAttempts` or `expirationMs` keeps retrying instead
of settling exhausted or dying with `SuspendedResumeGaveUp { reason: "expired" }`.
