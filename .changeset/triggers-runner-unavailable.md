---
"@smthrs/triggers": minor
---

Add the `TriggerError` code `runner_unavailable`: a `Runner.start` that cannot launch now, for an outage it expects to pass, fails with it, and the scheduler keeps the occurrence pending so the next tick retries it under the same idempotency key. `runner` still records the occurrence `failed`.
