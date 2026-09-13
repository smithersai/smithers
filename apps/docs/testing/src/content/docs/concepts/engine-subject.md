---
title: "The engine subject seam"
description: "EngineSubject is the test-owned port a conformance pin drives: five methods, a flow described only by its steps, and the identity, interruption, and race semantics every implementation must produce."
sidebar:
  order: 3
editUrl: "https://github.com/smithersai/smithers/edit/main/packages/testing/docs/concepts/engine-subject.md"
---

`EngineSubject` is the port a conformance pin drives. A pin runs an arbitrary
engine through `run`, `result`, `interrupt`, `resume`, and `journal`, then
asserts on the journal it produced.

It is deliberately distinct from the production harness port `EngineLike` in
[`@smthrs/harness`](https://harness.smithers.sh/reference/api/), whose members are `sealStep`, `splice`, and
`suspend`. That port is the seam the built-in harness **consumes**; this one is
the seam a test **drives**. The two share a backing engine and nothing else,
and they are never interchangeable.

## A flow described only by its steps

A pin cannot author a real flow, because the point is to run the same case
against implementations that do not share an authoring model. So a
conformance flow is a `FlowSpec`: a name and an ordered list of `StepSpec`s.
A step is either a body to run or a race between branches:

```ts
import type { EngineSubject } from "@smthrs/testing"
import * as Effect from "effect/Effect"

const flow: EngineSubject.FlowSpec = {
  name: "example/two-steps",
  steps: [
    { key: "read", sealed: true, kind: "step", run: () => Effect.succeed("read") },
    {
      key: "race",
      sealed: true,
      kind: "race",
      branches: [
        { key: "fast", sealed: false, kind: "step", run: () => Effect.succeed("fast") },
        { key: "slow", sealed: false, kind: "step", run: () => Effect.never }
      ]
    }
  ]
}
```

A step body's error channel is `unknown` because the **pin** chooses the
failure value it wants the subject to journal. It is not a laundered engine
error, and it is the one place in this package where `unknown` is correct.

## Refused execution claims

A submission that conflicts with an existing execution's flow or payload fails
with `ExecutionConflictError`. A new idempotency key on that refused submission
remains available for a later run.

## What `sealed` selects

`sealed` selects a step's **identity**, not whether a replay may reuse a
recorded result. Both kinds replay their recorded outcome.

- **Sealed is content identity.** Every aliased occurrence of the key shares
  one recorded result.
- **Unsealed is occurrence identity.** Duplicate declared keys run and journal
  separately.

For a key that occurs exactly once the two are indistinguishable. Read `sealed`
as a choice between two identities, never as a switch that turns replay on or
off.

`FlowEngineLike` maps this onto the real engine directly: a sealed step
declares its spec key as the activity idempotency key, so the engine derives
content identity from it; an unsealed step declares none, so the engine derives
ordinal identity.

## The journal a pin reads

Every subject projects its own richer entries onto `JournalEntryLike` before
comparison: an `index`, a `stepKey`, a `kind`, an `outcome` of `completed`,
`aborted`, `failed`, or `suspended`, and an optional `value`.

`index` is carried explicitly because ordering is data. An engine that reads
its journal from a store with no `ORDER BY`, or a caller that filtered and
re-concatenated, hands over the same entries in another order, and every
assertion must still answer about the same entry.
`JournalAssertions.expectJournal` sorts by `index` before answering, and
`Divergence` compares `index` too: two journals whose entries disagree about
their own position are not the same journal.

## Cancellation goes through the cooperative path

`FlowEngineLike.interrupt` uses `FlowRuntime.interrupt`, which delivers the
interruption to the live body fiber. It is the durable engine's only
cancellation path: the release policy requires `interruptUnsafe` to fail there
with `unsafe_interrupt_unsupported`, so an adapter built on the unsafe path
could not run a single interrupt pin against the engine that ships.

Cancelling a suspended execution settles it as `aborted`. Subsequent `result`,
`resume`, and matching `run` calls return that terminal result. The adapter
refreshes its settlement from the runtime because cancellation can finish a
parked round before its registered body runs. Missing cancellation publication
fails with `EngineUnavailableError` after a bounded number of scheduler passes.

## Race semantics

A durable race has two obligations the pins hold an engine to.

**The losing branch is interrupted, and its interruption is journaled** as an
`aborted` outcome. A branch that was simply abandoned, with nothing written,
does not satisfy this.

**A replay reconstructs the journaled winner rather than re-racing.** The pins
prove it adversarially: they invert the timing on the replay so the recorded
loser would win a fresh race, and then require the recorded winner anyway. The
raced flow parks on a step after the race, so the replay resumes an unfinished
execution and has to rebuild the race from its journal. Resuming a flow that
already finished proves nothing here, because every subject hands back the
terminal result without re-entering the body.

A branch claims a replay slot from the same key ledger as a step, so `sealed`
selects a branch's identity exactly as it selects a step's. Two races that
reuse an unsealed branch key run and journal separately; two races that share a
sealed branch key replay one recorded result.

Both pins advance virtual time, so a runner must register them under a
deterministic clock. `Vitest.testEffect(...).effect`, and its `scoped` alias,
supplies one; `.live` does not.

## Two reference subjects, and a third for restarts

`MemoryEngine` is the reference implementation: an in-memory engine whose
durable state lives in an externally owned `EngineStore`. Closing one engine
instance's scope interrupts only that instance's fibers, and a fresh engine
built over the same store replays completed journal entries and continues at
the first unfinished step.

`FlowEngineLike` is the authoritative subject: the same port over the real
engine from [`@smthrs/engine`](https://engine.smithers.sh/reference/api/). `FlowEngineLike.layerOver` takes
any `Layer<FlowRuntime>`, which is how one case list certifies both the
volatile runtime and the durable one.

`RestartableEngine` adds the boundaries a lease-based reclaim has to recover
from. It holds one persistent store and swaps the live instance over it:

| Control            | What it does                                                                                                                                |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `restart`          | Closes the outgoing instance's scope, so its fibers are interrupted and its finalizers run. The orderly shutdown.                           |
| `kill`             | Replaces the live instance **without** closing the one it replaces. The SIGKILL state: a durable owner holding a run it will never release. |
| `restartAndResume` | `restart`, then `resume` on the fresh instance.                                                                                             |
| `killAndResume`    | `kill`, then `resume` while the killed instance is still running and unreleased. The only variant that produces that state.                 |

A killed instance is left running deliberately, and the harness scope, not the
kill, owns closing it, so nothing leaks past the test that killed it.
