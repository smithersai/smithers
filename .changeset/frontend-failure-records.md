---
"@smthrs/observability": minor
"@smthrs/flow": minor
"@smthrs/engine-store": patch
"@smthrs/effect-tanstack-db": minor
"@smthrs/effect-electric": minor
"@smthrs/platform-browser": patch
---

Failures leave records where a program used to stay quiet. `@smthrs/observability` adds `LogFailures`, which counts every log line at Warn or above by record, code and area and keeps the latest for a report, and `FetchFailures`, which records each failed request a program's `fetch` sends by route template, status class and whether it repeats a failed one, so a sync client's quiet retries are counted. `@smthrs/flow`'s `RunMetrics.recordStep` writes `flow.step.failed` and counts `flows_step_failures` by the failure's code for a failed step attempt, which `@smthrs/engine-store` now passes. `@smthrs/effect-tanstack-db` logs `persisted restore failed` and counts `persistence_restore_failures` when a persisted collection can't restore its rows, `@smthrs/effect-electric` logs `electric.shape.stopped` and counts `electric_shape_stops` when Electric stops a shape. A migration that sets rows aside logs `device.migrate` at Warn. The outbox logs a write's first retry and a refusal, names a defect and a storage failure, and logs a parked write no feature takes on every load. `@smthrs/platform-browser`'s `BrowserRuntime.run` logs `browser.runtime.stopped` through its telemetry and `browser.runtime.uncaught` for an error or rejection nothing caught in the worker, and `browser.language_server.failed` names the worker's error. None of them records a message, a URL's path or query, or a collection's full id. Uses the library catalog's `@smthrs/observability` entry.
