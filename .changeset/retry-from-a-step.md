---
"@smthrs/flow": minor
"@smthrs/engine": minor
"@smthrs/engine-store": minor
---

Retry a settled run from one of its steps. `flow.retryFrom(source, { step, executionId? })` starts a new root run with the payload `source` was admitted with, in which every step attempt that finished before `step` began, in `source`'s journal order, replays from `source`'s record, and `step` and every step after it run. `source` is not changed. The port gains an optional `FlowRuntime.retryFrom` and the typed refusal `FlowRuntime.RetryFromRefused` (`unsupported`, `not_found`, `other_flow`, `not_settled`, `step_not_found`, `step_not_run`); `ExecutionIdentityConflict` gains the `retry` field, and a `.child()` boundary's `NodeSettled` names the child it opened (`childExecutionId`).

`@smthrs/engine`'s `Encoded` gains an optional `retryFrom` that `makeUnsafe` forwards for a flow placed here and refuses `unsupported` for one placed on another engine.

`@smthrs/engine-store` implements it on SQLite and PostgreSQL: the new run is admitted in one transaction with the source as its first key origin and the source's finished attempts copied (`DurableEngineState.copyAttempts`), so they replay through the engine's fork key resolution. A boundary settled before the step carries the child the source opened there, replayed whole. A plan that differs from the one the source recorded fails the new run with `plan_changed` before any step runs. The run records a `retry-from` decision with counts, and `flows_engine_retries_from` and `flows_engine_retry_seeded_attempts` count outcomes and copied attempts. Uses the library catalog's `@smthrs/flow` durable engine entry.
