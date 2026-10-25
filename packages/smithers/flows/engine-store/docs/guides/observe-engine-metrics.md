---
title: "Observe engine metrics"
description: "The counters and timers this package records on its hot paths, the outcome dimension every counter carries, and how to instrument your own effect with the same shape."
sidebar:
  order: 10
---

`EngineStoreMetrics` exposes the metric handles the engine updates and the
combinator it updates them with. It exports no exporter: wiring metrics to a
backend is the host's job, and belongs to
[`@smthrs/observability`](/api/observability).

## What is recorded

Every counter is dimensioned by an `outcome` attribute, and every hot path has a
matching duration timer.

| Metric                                          | What it counts or times                                                                                                                                                                |
| ----------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `flows_engine_dispatches`                       | Durable action dispatches. A cache-served replay and a fresh execution both count: the dispatch is the unit the engine retries and fences.                                             |
| `flows_engine_dispatch_duration`                | One dispatch, from admission through settlement, including cache verification, execution, copy-back, and the terminal row.                                                             |
| `flows_engine_scheduler_admissions`             | Plan-scheduler admissions.                                                                                                                                                             |
| `flows_engine_scheduler_dispatch_duration`      | One scheduler node dispatch.                                                                                                                                                           |
| `flows_engine_scheduler_nodes`                  | Node settlements, dimensioned by outcome.                                                                                                                                              |
| `flows_engine_sandbox_executions`               | Workspace transaction executions.                                                                                                                                                      |
| `flows_engine_sandbox_execution_duration`       | One workspace transaction.                                                                                                                                                             |
| `flows_engine_sandbox_materializations`         | Copy-back attempts.                                                                                                                                                                    |
| `flows_engine_sandbox_materialization_duration` | One copy-back.                                                                                                                                                                         |
| `flows_engine_sandbox_conflicts`                | Materialization conflicts, the refusals a rebase answers.                                                                                                                              |
| `flows_engine_storage_unavailable`              | Action attempts interrupted because the engine store was unavailable while the attempt was admitted, run or recorded. Each releases its run for a later drive that adopts the attempt. |
| `flows_engine_drive_yields`                     | Hosted drives that spent their budget (`EngineStore.drive`'s `budgetMs`) and yielded at a step boundary. Each releases its run for a drive that follows at once.                       |
| `flows_engine_held_drives`                      | Hosted drives that drove their run again for a wake due within `holdMs` of its park, which its host would wake it for with a new invocation.                                           |
| `flows_engine_replay_seeds`                     | Rounds that read their run's attempt rows and journal entries at once, so the steps a resumed run replays answer without a read or a write of their own.                               |
| `flows_engine_boundary_settlements`             | Step boundary settlements.                                                                                                                                                             |
| `flows_engine_step_cache_decisions`             | What a dispatch actually did with a cache row, after read-set verification and output materialization.                                                                                 |
| `flows_engine_claims`                           | The run driver's claim-and-activate decisions.                                                                                                                                         |
| `flows_engine_step_logs`                        | Log records action attempt bodies emitted, by `outcome`: `journaled` to the step, or dropped as `dropped_limit`, `dropped_queue`, `dropped_journal`, `dropped_flush` or `failed`.      |

Each counter also has a tag-keyed record of attributed views, so a caller
updates the right dimension by name rather than by re-attributing:

| View                 | Keys                                                                                               |
| -------------------- | -------------------------------------------------------------------------------------------------- |
| `dispatch`           | `Success`, `Failure`, `Interrupt`                                                                  |
| `sandboxExecution`   | `Success`, `Failure`, `Interrupt`                                                                  |
| `materialization`    | `Success`, `Failure`, `Interrupt`                                                                  |
| `node`               | `built`, `clean`, `failed`, `skipped`, `deferred`                                                  |
| `boundarySettlement` | `Clean`, `Deviation`, `Violation`, `Refused`                                                       |
| `stepCacheDecision`  | `VerifiedHit`, `Miss`, `UnverifiableEvidence`, `Unmeasurable`, `StaleReadSet`, `ReplayFailed`      |
| `claim`              | `Activated`, `Terminal`, `HeartbeatFresh`, `StealRefusedOwnerAlive`, `ClaimLost`, `ActivationLost` |

`stepCacheDecisions` is the series to read when you are asking why a step ran.
`VerifiedHit` served the cached result; every other value fell through to a real
execution. `Miss` is no row at all, `UnverifiableEvidence` a row whose recorded
evidence cannot justify reuse, `Unmeasurable` a host that could not re-measure
the read set, `StaleReadSet` a measured mismatch, and `ReplayFailed` verified
evidence the host could not re-materialize. At most one decision is counted per
cache-consulting dispatch, so a dispatch that fails or is fenced out
mid-decision records none and shows up in `flows_engine_dispatches` instead.

An `Invalidated` workspace verdict counts as a `Success` exit on
`sandboxExecution`: the transaction ran and answered, and the verdict itself is
journaled.

## Classify an exit

`ExitTag` is `"Success"`, `"Failure"` (any non-interrupt cause), or
`"Interrupt"` (an interrupt-only cause, which in this store covers the fencing
self-interruption as well as caller cancellation).

```ts
import { EngineStoreMetrics } from "@smthrs/engine-store"
import * as Effect from "effect/Effect"

const tag = Effect.map(Effect.exit(someEffect), EngineStoreMetrics.exitTag)
```

Outcome tags are rewritten as snake case attribute values, so `HeartbeatFresh`
is recorded as `heartbeat_fresh`.

## Instrument your own effect the same way

`observe` composes a duration timer with an exit-outcome counter and a span
annotation, and propagates the instrumented effect's exit byte-identically,
value, cause, and interruption alike:

```ts
const instrumented = someEffect.pipe(
  EngineStoreMetrics.observe({
    timer: EngineStoreMetrics.dispatchDuration,
    counter: EngineStoreMetrics.dispatch
  })
)
```

It is built on Effect's own `Effect.trackDuration`, which uses the monotonic
clock and records on success, failure, and interruption alike.

## Export them

Provide an exporter from your host composition. See
[Observability](/docs/guides/observability/) on smithers.sh for the OTLP wiring
the CLI uses.
