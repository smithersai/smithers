---
title: "Troubleshooting"
description: "Every Retrying failure an alarm reports, the other states an execution can stall in, and the change that resolves each."
---

## An alarm keeps returning `Retrying`

The `cloudflare.execution.alarm` line and span carry the failure's tag as
`error.type`, and the attempt count as `smithers.execution.attempt`. The alarm
backs off from one second, doubling, to five seconds, and never gives up.

A failure that reached the database adds the SQL error's kind as `db.error`
(`ConnectionError`, `SqlSyntaxError`, ...) and its SQLSTATE code as
`db.response.status_code`. A `ConnectionError` adds the driver's text for it as
`db.error.message`: `PgConnection: Connection closed` when the connection was
lost, `PgConnection: Connection timed out` or `PgConnection: Failed to connect`
when it never opened. A failed schema migration (`MigrationError`) adds its
cause:

| Field               | Value                                                                                         |
| ------------------- | --------------------------------------------------------------------------------------------- |
| `db.migration`      | The migration that failed, as `<id>_<name>`, such as `3006_engine-store_execution_listing`.   |
| `db.migration.kind` | `Failed`, `BadState`, `ImportError` or `Duplicates`.                                          |
| `error.message`     | The migration error's own text.                                                               |
| `db.query.text`     | The statement that failed.                                                                    |
| `db.error.message`  | The database's message, except for a data exception (SQLSTATE class `22`), which quotes data. |

| `error.type`                                                                               | Cause                                                                                                                                                                                                                               | Resolution                                                                                                                                                                                                                    |
| ------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `@smthrs/platform-cloudflare/UnknownFlow`                                                  | The stored intent names a flow that is not in `alarm`'s `flows`.                                                                                                                                                                    | Add the flow to `flows`. A child or next round runs on an object of the same class, so list every flow an execution may start or hand off to. A deploy that removed one leaves its executions retrying until one restores it. |
| `@smthrs/engine/FlowNotRegistered`                                                         | The flow is in `flows`, but the runtime's registration does not register it.                                                                                                                                                        | Register it in the layer passed to `CloudflareRuntime.layer`.                                                                                                                                                                 |
| `@smthrs/platform-cloudflare/Undriven`                                                     | The runtime would not claim the execution, or what it waits on came due during the drive.                                                                                                                                           | Build the runtime with `executionId: intent.executionId`. A wait that came due resolves on the next alarm.                                                                                                                    |
| `SchemaError`                                                                              | The stored payload no longer decodes with the flow's payload schema, or the intent is not an intent.                                                                                                                                | Keep the payload schema able to decode payloads already stored, or settle those executions before the change ships.                                                                                                           |
| `SqlError` or another database tag                                                         | The database was unreachable or refused a statement while the runtime was built.                                                                                                                                                    | Check the Hyperdrive origin and the schema's privileges. The alarm resumes the run once the database answers.                                                                                                                 |
| `@smthrs/database/DatabaseError` with `db.error.message` `PgConnection: Connection closed` | Behind Hyperdrive, every server connection its configuration grants was held and the client waited 15 seconds for one. Writers queued on the engine schema's writer lock held them all before `@smthrs/database` bounded that wait. | Build the engine's database with `PostgresDatabase.layer`, whose writers let their connection go after `writerLockTimeout`. A rising `flows_db_writer_lock_timeouts` count means more writers than the lock serves.           |
| `MigrationError`                                                                           | The engine's schema could not be installed or upgraded. `db.migration` names the migration.                                                                                                                                         | Read `db.query.text` and `db.error.message`. `Connection closed` behind Hyperdrive is a client that prepares statements by name; build the database with `PostgresDatabase.layer`.                                            |
| The router's own error tag                                                                 | A `router.start` or `router.wake` call failed: the other object refused it or could not be reached.                                                                                                                                 | Check the router reaches the class's own namespace by execution id. The next alarm routes the same executions again.                                                                                                          |

## The flow settled as failed after a database outage

A connection lost while the engine records a step's result fails the run
today: the engine records the database failure as the step's outcome, and the
alarm then reads a settled run. The alarm retries only failures that leave the
run unsettled.

## The flow settled as failed with `plan_changed`

The engine logs `InterpreterError` with code `plan_changed` when the plan an
incarnation rebuilds differs from the one recorded. Each alarm can run in a new
isolate, so a flow's callbacks need stable identity. Register the flow with
`Interpreter.layerWithImplementations` and write its body with `Node.capture`,
capturing every value the callback reads.

## The flow settled as failed with `payload_changed`

A deploy changed the flow's payload schema so it no longer decodes the payload
the run recorded, such as a new required field. The object decodes the stored
intent's payload only to admit an execution the store does not hold yet; a run
the store holds resumes from its recorded payload, and the engine settles it
`failed` with `InterpreterError` code `payload_changed` instead of retrying.
An intent whose run was never admitted still fails each alarm with
`error.type` `SchemaError`. See
[`@smthrs/engine-store` troubleshooting](../../engine-store/docs/troubleshooting.md#a-run-resumed-after-a-deploy-fails-with-payload_changed)
for the schema-evolution rule.

## The execution is `Parked` with `wakeAtMs: null` and never resumes

The run waits on an event, such as a `DurableDeferred` or a person, with no
timer. Nothing in the object will wake it. Whoever completes the deferred must
also call the object's `wake`, through an RPC method on the object that calls
`ExecutionObject.wake`.

A parent waiting on a child is woken by the child's own alarm when the child
settles. When it is not, find the child's run: one still `pending` was never
started on its object, so the parent's routing failed (see `error.type` on
the parent's alarm); one settled whose parent is still parked means the
child's alarm could not reach the parent's object. Either object's next alarm
routes again, so calling `wake` on it resolves both.

## A cancelled execution keeps running

A cancellation is recorded in the store, and an object only reads it when its
alarm fires. Call `wake` on the object after cancelling. Its alarm closes the
run and wakes each linked child the cancellation reached.

## `start` fails with `IntentConflict`

The object already holds an intent for this execution id with another payload or
flow. An execution id names one run: give a new request a new id.

## A step ran twice

A step interrupted by a reset, an eviction or a crash runs again in the next
incarnation; steps that settled before it replay from the journal. Make every
step's effects idempotent, and key any external call so a repeat is harmless.

## A step fails with `unsupported_boundary`, or a file or process call fails

The step declares a file boundary, reads a file or starts a process. A Worker
has none of them: `FileSystem` refuses with `PermissionDenied`,
`ChildProcessSpawner` with `NotFound`, and `Jj` with `not_installed`. Run that
work on a sandbox host from `@smthrs/sandbox`.

## `EdgeCache` misses what an earlier request stored

The Workers cache is per data center and may evict any entry, so a request
served elsewhere, or after an eviction, misses and reads the source again. The
dashboard editor and Playground previews ignore every Cache API call. A layer
with a `name` reads only its named cache, never `caches.default`. Count
`immutable_cache_requests` by `outcome` to see the hit rate.

## `EdgeCache.layer` fails with `unavailable`

The runtime has no `caches` global, or the layer was given no `name` and the
runtime's `caches` has no `default`, as in a browser. In Node, inject a
`CacheStorage` through `options.caches`, or use `ImmutableCache.layerMemory`.

## An execution runs slowly

Read the `cloudflare.execution.alarm` lines of its execution id. Each says how
long the alarm took (`durationMs`), how many journal entries it committed
(`events`), how many write transactions it ran (`transactions`), how many of
those held the whole schema's writer lock (`schemaWide`), and how long they
waited, in total, for their locks (`lockWaitMs`). A `lockWaitMs` near
`durationMs` means the alarm spent its time queued behind other writers, not
running steps. Schema-wide transactions wait for every other execution's
writes, so a drive should have none once the schema is installed.

### Startup and cumulative acquisition time

`cloudflare.execution.ready` follows runtime layer construction, including
database opening, migration checks, store construction and flow registration.
Just before it, `engine-store.registration.recovered` reports how many
registrations recovered clocks and completions (`registrations`) and how long
that one recovery took (`durationMs`). Given the intent's flow tag (`flow`), a
runtime recovers only that flow's registrations, so a count near the catalog's
size means it was built without one.

`lockWaitMs` adds client-side acquisition durations. It includes BEGIN and
network round trips, so dividing it by the transaction count is only an
approximation (savepoints can acquire additional locks). It is not a single
blocked-lock duration. Use `maxLockWaitMs`, the maximum acquisition observation, to distinguish
a long acquisition from many short ones; database lock wait records are still
needed to distinguish server contention from transport latency.
