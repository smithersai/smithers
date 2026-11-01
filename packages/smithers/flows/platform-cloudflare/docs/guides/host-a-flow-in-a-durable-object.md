---
title: "Host a flow in a Durable Object"
description: "Wire an Alchemy Effect-native Durable Object to ExecutionObject, bind it to the Worker that starts executions, and reach Postgres through Hyperdrive."
---

This guide hosts a flow, `Answer`, in an Alchemy Effect-native Durable Object.
Alchemy runs every handler, so the code below runs no Effect itself.

## 1. Declare the object

Declare the class with the shape its callers see: `start` and `wake` RPC
methods and the `alarm` handler. All three use the object's storage, whose
methods require Alchemy's `RuntimeContext`. Other objects of the class call
`start` and `wake` too: a parent's alarm starts its child's object, and a
settled child's alarm wakes its parent's.

```ts
// worker/AnswerExecution.ts
import * as Pg from "@effect/sql-pg"
import { PostgresDatabase } from "@smthrs/database"
import { CloudflareRuntime, ExecutionObject } from "@smthrs/platform-cloudflare"
import type { RuntimeContext } from "alchemy"
import * as Cloudflare from "@alchemy.run/cloudflare"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Redacted from "effect/Redacted"
import { Answer, AnswerLive } from "./Answer.ts"
import { ChatDatabase } from "./ChatDatabase.ts"

export interface AnswerExecutionShape {
  readonly start: (
    intent: ExecutionObject.Intent
  ) => Effect.Effect<void, ExecutionObject.IntentConflict, RuntimeContext>
  readonly wake: () => Effect.Effect<boolean, never, RuntimeContext>
  readonly alarm: () => Effect.Effect<void, never, RuntimeContext>
}

export class AnswerExecution extends Cloudflare.DurableObject<AnswerExecution, AnswerExecutionShape>()(
  "AnswerExecution"
) {}
```

`Answer` is the flow and `AnswerLive` its registration, built with
`Interpreter.layerWithImplementations` so a new incarnation rebuilds the plan
the previous one recorded. `ChatDatabase` is the `Cloudflare.Hyperdrive.Connection`
resource, with its query cache disabled.

## 2. Implement it

The outer effect resolves the object's state, the class's own namespace and the
Hyperdrive binding once; the inner one returns the handlers:

```ts
export const AnswerExecutionLive = AnswerExecution.make(
  Effect.gen(function*() {
    const state = yield* Cloudflare.DurableObjectState
    // This class's own namespace: each execution's object, by execution id.
    const executions = (yield* Cloudflare.DurableObject) as Cloudflare.DurableObject<AnswerExecutionShape>
    const hyperdrive = yield* Cloudflare.Hyperdrive.Connect(ChatDatabase)
    const database = Layer.unwrap(
      Effect.map(
        hyperdrive.connectionString,
        (url) => PostgresDatabase.layer({ url: Redacted.value(url), driver: Pg, schema: "smithers_flows" })
      )
    )
    return Effect.succeed({
      start: (intent: ExecutionObject.Intent) => ExecutionObject.start(state.storage, intent, Effect.void),
      wake: () => ExecutionObject.wake(state.storage),
      alarm: () =>
        ExecutionObject.alarm(state.storage, {
          flows: [Answer],
          runtime: (intent) =>
            CloudflareRuntime.layer({ hostId: state.id.toString(), executionId: intent.executionId }, AnswerLive)
              .pipe(Layer.provide(database)),
          router: {
            start: (intent) => executions.getByName(intent.executionId).start(intent),
            wake: (executionId) => Effect.asVoid(executions.getByName(executionId).wake())
          }
        }).pipe(Effect.asVoid)
    })
  })
)
```

- `state.storage` satisfies `ExecutionObject.Storage<RuntimeContext>` as it is.
- `hostId` is the object's own id, the same for every incarnation of it.
- `runtime` is a function of the intent, and `database` is a layer, so the
  engine and its connection are built inside each alarm and closed when it ends.
- `router` reaches the object of any other execution through the class's own
  namespace. The alarm starts each child and next round its drive admitted on
  its own object, and wakes each parent its settlement made due. A call that
  fails re-arms this object's alarm with backoff, and the next alarm routes
  again.
- `flows` lists every flow an execution may start as a child or hand off to:
  their objects are this class too.
- Replace `Effect.void` with the caller's own idempotent write when the request
  must leave a row behind before it is answered, such as an answer row in
  `streaming` state. The flow's first step must do the same write, because an
  alarm can run the flow even when `start` died before that write.

## 3. Bind it to the Worker that starts executions

The hosting Worker resolves the namespace during initialization and provides the
object's implementation, with the Hyperdrive binding it needs:

```ts
export class Api extends Cloudflare.Worker<Api>()(
  "Api",
  { main: "worker/Api.ts", compatibility: { date: "2026-10-01", flags: ["nodejs_compat"] } },
  Effect.gen(function*() {
    const executions = yield* AnswerExecution
    return {
      fetch: Effect.gen(function*() {
        const { executionId, payload } = yield* readRequest
        const intent = yield* ExecutionObject.intent(Answer, { executionId, payload })
        yield* executions.getByName(executionId).start(intent)
        return HttpServerResponse.empty({ status: 202 })
      })
    }
  }).pipe(Effect.provide(AnswerExecutionLive.pipe(Layer.provideMerge(Cloudflare.Hyperdrive.ConnectBinding))))
) {}
```

`getByName(executionId)` reaches the same object for the same id from any
Worker isolate, so a retried request lands on the object that already holds the
intent. The response is sent once `start` returns; the flow runs from the
object's alarm.

`readRequest` stands for your own request decoding. Bound its size and decode it
with a schema before it becomes a payload.

## 4. Run it locally

`alchemy dev` runs the Worker and the object in local workerd and passes the
Hyperdrive binding through to the origin, such as the compose Postgres. Alarms
fire on time there too.

## 5. Watch it

Every `start`, `wake` and alarm logs, traces and counts itself:
`cloudflare.execution.start`, `cloudflare.execution.wake` and
`cloudflare.execution.alarm` lines, inside spans of the same names, and the
`smithers_cloudflare_execution_starts`, `smithers_cloudflare_execution_wakes`
and `smithers_cloudflare_execution_alarms` counters, by outcome.
`smithers_cloudflare_execution_routed` counts the executions alarms started and
woke on other objects, by `route`, and each alarm span carries the counts as
`smithers.execution.started` and `smithers.execution.woken`. Each start and alarm line and span names its execution and
flow as `smithers.execution.id` and `smithers.flow`. A `Retrying` alarm
also carries `error.type` and `smithers.execution.attempt`, and a failure that reached the database its SQL error's
kind and code, and for a lost or refused connection the driver's text for it. None of them carries the payload or a flow's failure message; only a failed schema migration adds its
statement and the database's message. [Troubleshooting](../troubleshooting.md) maps each `error.type` to its
cause.

Keep one `ExecutionObject.make` instance per object incarnation. Its alarm handler serializes concurrent drives, including RPC calls that drive an admitted execution immediately. Waiting callers reuse the recorded result after the active drive completes. Cancellation uses its own admission gate and can still interrupt the active drive.
