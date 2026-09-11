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

The declared options are `payload`, `success`, `error`, `tier`,
`idempotencyKey`, `nondeterministic`, and `annotations`. `success` defaults to
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

Inside the implementation you can read three references the runtime supplies:

| Reference                     | What it carries                                                                |
| ----------------------------- | ------------------------------------------------------------------------------ |
| `Action.CurrentAttempt`       | The one-based durable attempt. Defaults to `1`.                                |
| `Action.CurrentInvocationKey` | The persisted key of the dispatch, when the runtime supplies one.              |
| `Action.CurrentOrdinal`       | The `OrdinalSlot` of the enclosing `Action.retry` sequence, when there is one. |

The implementation may also require services of its own. Those requirements
appear on the returned layer, so a composition that forgot a database client
fails to compile the same way a missing action implementation does.

## Choose the tier

The tier tells the engine what retrying this action means. It is part of the step
key, so it is not a hint.

| Tier           | Choose it when                                        | What the engine does                                                                                                                                                                                                                                            |
| -------------- | ----------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `sealed`       | The result is a pure function of the declared inputs. | Records the result and replays it. With the right declarations, reuses it across runs.                                                                                                                                                                          |
| `compensable`  | The body changes the workspace.                       | Takes a pre-image before each attempt and restores it before the next one, so attempt two does not trip over attempt one's half-written files. Requires a `FlowEngine.SnapshotBoundary` in context, which [`@smthrs/engine-store`](/api/engine-store) supplies. |
| `irreversible` | The body changes the world outside the workspace.     | Refuses to retry without a declared `idempotencyKey`, dying with `IrreversibleRetryRequiresIdempotencyKey`.                                                                                                                                                     |

`sealed` is the default, and it is a claim about the body: this result is worth
replaying. Add `nondeterministic: true` when several legitimate results may race
under one cache key, so a conflict is resolved first-writer-wins instead of being
reported as a hermeticity violation. The flag is key material, so a tolerant
declaration never consumes a strict declaration's recorded row.

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

## Related pages

- [Flows and actions](../concepts/flows-and-actions.md): why the split exists.
- [Retry a failing action](./retry-a-failing-action.md): what a policy does, and
  where a policy can be declared.
- [Reuse a recorded result](./reuse-a-recorded-result.md): the three declarations
  a sealed result needs before it can be shared.
