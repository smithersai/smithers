---
"@smthrs/flow": patch
"@smthrs/control": patch
"@smthrs/triggers": patch
---

Every exponential wait in Smithers is computed by `RetryPolicy.nextDelay`: `ExternalJob` probes, exponential `Poll`
backoff, `Health.nextDelay`, trigger scheduling, browser engine run reads, run-lease steal refusals, AWS sandbox
readiness polls, runner credential waits and build-cli rename retries. The waits are unchanged, with two edge cases in
`Poll.delayMillis`: a doubling that overflows is `Number.MAX_VALUE` milliseconds rather than `Infinity`, and an attempt
that is not a positive whole number waits `Infinity`. `@smthrs/triggers` now depends on `@smthrs/flow`.
