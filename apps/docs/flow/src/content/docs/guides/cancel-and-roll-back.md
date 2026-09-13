---
title: "Cancel a run and undo its effects"
description: "Request cancellation of an execution, register a rollback for a successful effect, add a finalizer to the flow scope, and know which undo belongs to the engine."
sidebar:
  order: 9
editUrl: "https://github.com/smithersai/smithers/edit/main/packages/smithers/flows/flow/docs/guides/cancel-and-roll-back.md"
---

Stopping a durable run and undoing what it already did are two separate jobs.
This package gives you a request for the first and three mechanisms for the
second, and each of the three covers a different kind of work.

## Request cancellation

```ts
// `Checkout` is a flow declaration; the id names one of its executions.
const stop = Checkout.interrupt("checkout-42")
```

`interrupt` is not a pause. The engine interrupts active work while preserving
its normal cleanup, compensation, and child-flow semantics, and calling `resume`
afterwards does not undo the cancellation request.

A durable engine records the request **before** it interrupts anything, and
reports `FlowRuntime.CancelRequestFailed` when that record could not be written.
The execution is then still running, so the caller sees the storage failure
instead of a false success. An in-memory engine has nothing to record and never
raises it.

The same failure carries `unsafe_interrupt_unsupported` when a durable engine is
asked for `interruptUnsafe`, which it does not implement.

## Undo a successful effect

`Flow.withRollback` registers how to undo an effect's successful result if the
current round later exits unsuccessfully:

```ts
import { Flow } from "@smthrs/flow"

const reserved = Flow.withRollback(
  reserveInventory(order),
  (reservation, cause) => releaseInventory(reservation, cause)
)
```

The three cases are worth stating exactly:

- If the effect itself fails, no rollback is registered. There is nothing to undo.
- If both the effect and the round succeed, the rollback is discarded.
- If the effect succeeds and the round exits unsuccessfully, the rollback
  receives the effect's successful value and the round's failure cause when
  the scope closes.

A handoff completes the round successfully and discards its `withRollback` registrations.
Failure or cancellation in a later round cannot invoke those rollbacks. The
engine does not provide lineage-scoped compensation; compensation across rounds
requires an explicit durable design. These in-memory finalizers are not durable
compensation records.

This applies only to effects run directly inside the flow execution. It does
**not** attach rollback behavior to nested actions. An action that changes the
world undoes itself through its tier, which is the next section.

`flow.withRollback` is the same function reachable off a flow declaration, typed
with that flow's error channel.

## Clean up on exit

`Flow.addFinalizer` registers an exit finalizer on the flow scope, preserving the
services available where it was registered:

```ts
import * as Effect from "effect/Effect"

const withCleanup = Effect.gen(function*() {
  const handle = yield* openHandle()
  yield* Flow.addFinalizer(() => closeHandle(handle))
  return handle
})
```

Suspension keeps the current round's scope open for a re-drive of the same
instance. Terminal completion closes it with the round's success or failure
exit. Handoff closes it with a success exit and runs its finalizers; the next
round has a fresh scope. `Flow.scope` and `Flow.provideScope` refer to this
round's scope. Its resources and finalizers do not survive process death.

## Let the engine undo the work

An action whose body changes the workspace declares `tier: "compensable"`. The
engine then takes a pre-image before each attempt and restores it before the
next one, so an action that failed halfway through leaves nothing behind for
attempt two to trip over. The undo is the engine's rather than the body's, and
it needs a `FlowEngine.SnapshotBoundary` in context, which
[`@smthrs/engine-store`](https://engine-store.smithers.sh/reference/api/) supplies.

Choosing between the three:

| The work                                               | The undo                                                                                                 |
| ------------------------------------------------------ | -------------------------------------------------------------------------------------------------------- |
| An action that writes to the workspace                 | `tier: "compensable"`. The engine snapshots and restores.                                                |
| An action that changes the world outside the workspace | `tier: "irreversible"` plus an `idempotencyKey`. There is no undo, so the engine refuses to retry blind. |
| An effect inside a handler                             | `Flow.withRollback`, or `Flow.addFinalizer` when the cleanup is unconditional.                           |

## Related pages

- [Attach an implementation to an action](/guides/implement-an-action/): choosing a
  tier.
- [Run a flow as a child execution](/guides/run-a-child-flow/): how cancellation
  travels down a lineage.
- [Suspension and replay](/concepts/suspension-and-replay/): scope lifetime
  across suspension, completion, and handoff.
