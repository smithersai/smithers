---
title: "Steer a run"
description: "Admit messages from outside the chain; the root chain drains them at link boundaries into author-call context."
sidebar:
  order: 5
---

The `Steering` port carries messages from outside the chain (a user typing
while the agent works) into author-call context. It is optional: a chain
without the service runs unchanged and journals identically.

## Admit and drain

The service has two operations:

```ts
interface Service {
  readonly admit: (message: string) => Effect.Effect<void, SteeringError>
  readonly drain: (boundary: string) => Effect.Effect<ReadonlyArray<string>, SteeringError>
}
```

`admit` appends a message from outside. `drain` takes every queued message at
a named boundary. The boundary names the journal position the drain feeds
(`link/ordinal` for the empty root scope, `chain/link/ordinal` for a named root), so a durable binding can make the take exactly-once by
deduping on it. `Steering.layerMemory()` is the in-memory stand-in: `admit`
appends, `drain` takes everything, and it ignores the boundary, accepting the
volatile loss window that implies.

```ts
import { Steering } from "@smthrs/chain"
import { Effect } from "effect"

const program = Effect.gen(function*() {
  const steering = yield* Steering.Steering
  yield* steering.admit("prefer the smaller patch")
}).pipe(Effect.provide(Steering.layerMemory()))
```

## How the chain drains

Every root chain, including a named root, drains; a sub-chain never does, so an instruction meant
for the root is never consumed by an unattended child. The chain drains the
queue when it issues a live author call, at that call's scoped boundary, and
appends each drained line to the author context as `[steering] <line>`,
after the context the call already carries (the goal, caller lines, and
observations on a harness call, or the `context` a script passed). A chain with the goal
`fix TODOs` that drains `ship it today` authors with
`["fix TODOs", "[steering] ship it today"]`.

Two rules keep replay deterministic:

- A non-empty drain journals a `SteeringDrained` event tied to the author
  call it fed. A re-executed attempt reuses the recorded lines instead of
  draining again; recorded drains are never re-drained.
- Drained lines are link-cumulative: every author attempt of a link sees all
  lines drained into the link so far, so a gate-rejected attempt never
  swallows the user's instruction.

An empty drain journals nothing: a settled author call already pins its full
context in its `CallSettled` payload.

## Failure behavior

A mounted-but-broken queue fails the run with `SteeringError`, code
`steering_unavailable`. It reaches the caller typed; it is never absorbed
into an observation. The noop layer (`Steering.layerNoop()`) fails the same
way, which makes it the default a test starts from.

For the event the drain journals, see [The journal](../concepts/journal.md).
For the error taxonomy, see [Troubleshooting](../troubleshooting.md).
