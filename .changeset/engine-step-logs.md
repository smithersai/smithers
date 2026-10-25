---
"@smthrs/journal": minor
"@smthrs/observability": patch
"@smthrs/engine-store": minor
---

What an action attempt's body logs is now journaled to its step, on every host. Each record at or above the ambient minimum level becomes a `telemetry.log` event in the attempt's run while the body runs, annotated with `runId`, `stepKeyDigest` and `attempt`, redacted with the diagnostic rules, and bounded by `StepLogs.Limits` (1,000 records of 4 KiB per attempt by default; `records: 0` turns it off). Delivery is lossy and never blocks the body: losses are counted on `EngineStoreMetrics.stepLog` and summarized in one `step_logs_dropped` record, and a replayed step writes none. The ambient loggers keep every record and gain the `stepKeyDigest` annotation.

The `telemetry.log` schema and its bounded snapshot move to `@smthrs/journal`'s new `TelemetryLog` module, which both the engine and `@smthrs/observability`'s `JournalLogger` use; `JournalLogger` re-exports them under its existing names. A logged Effect `Redacted` value now reads `<redacted>` instead of `{}`, and an explicit `maximumBytes` bound reserves the record's envelope so a long message is cut rather than dropped.

Uses the library catalog's `@smthrs/journal` and `@smthrs/observability` entries.
