---
title: "Attach an implementation to an action"
description: "Declare an action, write its implementation with toLayer, choose its tier, and compose the layers in the order the implementation table requires."
sidebar:
  order: 1
---

An action declaration holds no code. This guide attaches the code, picks the tier
that describes what the code does to the world, and composes the layers in the
one order that works.

## Declare the action

```ts
import { Action } from "@smthrs/flow"
import * as Schema from "effect/Schema"

export class ChargeDeclined extends Schema.TaggedError<ChargeDeclined>()(
  "payments/ChargeDeclined",
  { reason: Schema.String }
) {}

export const Charge = Action.make("payments/Charge", {
  payload: { customer: Schema.String, cents: Schema.Number },
  success: Schema.String,
  error: ChargeDeclined,
  tier: "irreversible",
  idempotencyKey: { charge: "checkout-v1" }
})
```

The declared options are `payload`, `declaredFrom`, `implementationVersion`,
`success`, `error`, `capabilities`, `effects`, `tier`, `idempotencyKey`,
`nondeterministic`, `retryPolicy`, `interruptRetryPolicy`, `attemptTimeoutMs`,
`heartbeatTimeoutMs`, `fileBoundary`, and `annotations`. `success` defaults to
`Schema.Void` and `error` to `Schema.Never`, so an action that declares no error
schema cannot fail typed.

## Write the implementation

`toLayer` takes a function from the decoded payload to an effect and returns the
layer that provides this declaration's requirement:

```ts
import * as Effect from "effect/Effect"

export const charges = Charge.toLayer(({ cents, customer }) =>
  Effect.gen(function*() {
    const attempt = yield* Action.CurrentAttempt
    const result = yield* chargeCard(customer, cents, { attempt })
    return result.confirmation
  })
)
```

Inside the implementation you can read five references the runtime supplies:

| Reference                     | What it carries                                                                |
| ----------------------------- | ------------------------------------------------------------------------------ |
| `Action.CurrentAttempt`       | The one-based durable attempt. Defaults to `1`.                                |
| `Action.CurrentInvocationKey` | The persisted key of the dispatch, when the runtime supplies one.              |
| `Action.CurrentOrdinal`       | The `OrdinalSlot` of the enclosing `Action.retry` sequence, when there is one. |
| `Action.CurrentFence`         | The running attempt's ownership fence, when a durable engine supplies one.     |
| `Action.CurrentRedispatch`    | `true` when this attempt re-runs one an earlier execution never settled.       |

An implementation that writes its own tables fences each write with
`Action.CurrentFence`, so a write from an owner that lost the run, or from an
attempt that already settled, changes nothing:

```ts
import { RunStore } from "@smthrs/run-store"
import * as SqlClient from "effect/sql/SqlClient"

export const replies = Reply.toLayer(({ id, text }) =>
  Effect.gen(function*() {
    const sql = yield* SqlClient.SqlClient
    const fence = yield* Action.CurrentFence
    if (fence === undefined) return yield* Effect.die("Reply needs a durable engine")
    yield* sql`UPDATE replies SET text = ${text} WHERE id = ${id} AND ${RunStore.owned(sql, fence)}`
  })
)
```

The implementation may also require services of its own. Those requirements
appear on the returned layer, so a composition that forgot a database client
fails to compile the same way a missing action implementation does.

## Know which services a run sees

An implementation runs with the services its layer was built with, under the
services of the fiber that runs the flow. Where both hold the same service, the
run's wins. That is how the runtime hands each step its dispatch identity,
resume context and deadline, and how a test substitutes one service for one
`execute` call:

```ts
// A step that reads Greeting sees "caller", whatever its layer was built with.
Checkout.execute(payload, { executionId }).pipe(
  Effect.provide(wired),
  Effect.provideService(Greeting, "caller")
)
```

So a flow started from inside another flow's implementation, or from a fiber
forked there, runs its steps with that implementation's services. When the run
belongs to another composition, start it in that composition's own context,
captured where the composition is built:

```ts
const own = yield* Effect.context<never>()
// Later, inside another flow's implementation:
const run = Effect.updateContext<string, unknown, never, never>(
  Checkout.execute(payload, { executionId }),
  (): Context.Context<never> => own
)
```

`Effect.provideContext` does not isolate a run: it adds the services it is
given to the caller's, so the caller's other services stay visible.
`test/ActionServices.test.ts` checks all three cases.

## Choose the tier

The tier tells the engine what retrying this action means. It is part of the step
key, so it is not a hint.

| Tier           | Choose it when                                        | What the engine does                                                                                                                                                                                                                                                                                     |
| -------------- | ----------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `sealed`       | The result is a pure function of the declared inputs. | Records the result and replays it. With the right declarations, reuses it across runs.                                                                                                                                                                                                                   |
| `compensable`  | The body changes the workspace.                       | Takes a pre-image before each attempt and restores it before the next one, so attempt two does not trip over attempt one's half-written files. Requires a `FlowEngine.SnapshotBoundary` in context, which [`@smthrs/engine-store`](/api/engine-store) supplies, and a workspace that is a jj repository. |
| `irreversible` | The body changes the world outside the workspace.     | Refuses to retry without a declared `idempotencyKey`, dying with `IrreversibleRetryRequiresIdempotencyKey`.                                                                                                                                                                                              |

The `compensable` pre-image is a jj snapshot of the workspace, so the
workspace must be a jj repository: run `jj git init` in it first. Without one,
the step dies before its first attempt runs:

```text
@smthrs/jj/JjError: jj snapshot: Error: There is no jj repo in "."
```

`sealed` is the default, and it is a claim about the body: this result is worth
replaying. Add `nondeterministic: true` when several legitimate results may race
under one cache key, so a conflict is resolved first-writer-wins instead of being
reported as a hermeticity violation. The flag is key material, so a tolerant
declaration never consumes a strict declaration's recorded row.

## Write to another service once

A step that creates something outside the journal, such as a commit, a pull
request, a comment or an email, can lose the answer: the provider made the
object, then the process died or the connection dropped before the step's
outcome was recorded. The engine runs the step again, and the step has to tell
its own object from everyone else's. Never decide that from what the object
looks like: a title, a message, a branch name, a time window or "the latest"
adopts objects that only look alike and misses your own.

Write through `Action.once` instead. It derives the write's key from the
execution and the dispatch (`Action.effectKey`), so every run of the step
derives the same key and no other step does. The adapter puts the key on the
object in the request that creates it and finds the object by that key alone:

```ts
import { Action } from "@smthrs/flow"
import * as Effect from "effect/Effect"
import * as Option from "effect/Option"

declare const outbox: Map<string, string>

export const notify = Notify.toLayer(({ text }) =>
  Action.once(
    "notify",
    Action.keyed({
      find: (key) => Effect.sync(() => Option.fromUndefinedOr(outbox.get(key))),
      perform: (key) =>
        Effect.sync(() => {
          outbox.set(key, text)
          return text
        })
    })
  )
)
```

`once` calls `find` first and adopts what it answers. Only when `find` answers
none does it call `perform`, and when `perform` fails it calls `find` again, so
a write whose answer was lost is adopted rather than repeated. A `find` that
cannot tell, such as a search cut short by a page budget, must fail; `once`
never reads a failed lookup as "not made".

When the write's identity was chosen and recorded before the step ran, such as
a write id a device picked and stored with its request, pass it as
`Action.once(name, effect, { key })` so the object carries the id other code
already knows it by. Never build that key from what is written.

Declare such a step `tier: "irreversible"` with an `idempotencyKey`: its repeat
is safe, so a durable engine re-runs an attempt that died mid-write. A write
that can carry no key and has no lookup, such as a Telegram message, runs alone
in an `irreversible` step. Without an `idempotencyKey` the durable engine runs
it at most once; with one it accepts a repeat.

Provider adapters ship with their packages, such as `@smthrs/integrations`'
`GitHub.Once`.

## Compose the layers

Three rules, in the order they bite:

```ts
import { FlowEngine } from "@smthrs/engine"
import { Interpreter } from "@smthrs/flow"
import * as Layer from "effect/Layer"

export const layer = Layer.mergeAll(
  charges,
  Interpreter.layer(Checkout)
).pipe(
  Layer.provideMerge(Action.layerImplementations),
  Layer.provideMerge(FlowEngine.layerMemory)
)
```

1. Merge the implementation layers beside `Interpreter.layer(flow)`. The
   interpreter registers the flow and installs the handler that drives its body.
2. Provide `Action.layerImplementations` **under** them with
   `Layer.provideMerge`, never beside them. An implementation files itself in the
   table while its own layer is built, so the table has to be built first.
3. Provide the engine under that. Every declaration above it is engine agnostic.

A second, different implementation of one tag dies during layer construction
with `Action.DuplicateImplementation`. To substitute one on purpose, register it
with `action.toLayer(handler, { override: true })`. The override shadows the
earlier registration, and closing its scope restores what it shadowed. That is
what lets a test scope an override to one block without leaking it into the
next.

## Skip the layer for a nested operation

Not every durable step needs a declaration. Inside an implementation, the inline
form of `Action.make` is itself an `Effect`, and the engine records it as a step
of its own:

```ts
import { RetryPolicy } from "@smthrs/flow"

const settle = Action.make({
  name: "payments/Settle",
  success: Schema.String,
  error: Schema.String,
  tier: "irreversible",
  idempotencyKey: "settle:checkout-v1",
  retryPolicy: RetryPolicy.make({ initialMs: 200, factor: 2, maxMs: 10_000, maxAttempts: 5 }),
  execute: Effect.succeed("settled")
})
```

Both forms take `retryPolicy` and `interruptRetryPolicy`; only the inline form
takes `metadata`. The [`Action.make` reference](../reference/flow.md#actionmake)
is the one option table. Reach for the inline form when an implementation needs
a nested durable operation of its own; reach for the declared form when a body
should name the step.

Error encoding retains the originating cause annotations. A flow invoked inside an action can therefore report its own failing action and retry count through the enclosing action; durable engines retain the failure coordinates when replaying a failed attempt.

## Related pages

- [Flows and actions](../concepts/flows-and-actions.md): why the split exists.
- [Retry a failing action](./retry-a-failing-action.md): what a policy does, and
  where a policy can be declared.
- [Reuse a recorded result](./reuse-a-recorded-result.md): the three declarations
  a sealed result needs before it can be shared.
