---
title: "Fork a run at a frame"
description: "Branch a child run off a parent's frame: what the child inherits, how its workspace is named and pinned, why the warnings are not refusals, and the cache declaration that keeps sealed steps from re-executing."
sidebar:
  order: 2
editUrl: "https://github.com/smithersai/smithers/edit/main/packages/smithers/flows/time-travel/docs/guides/fork-a-run.md"
---

A fork copies a run's history up to a frame into a new run and leaves the
parent untouched. Use it to explore an alternative from a point that already
happened: retry a step under different inputs, branch a review, or drive a
finished run forward again without losing the original.

A fork does not make the copied prefix replayable. Read
[Keep sealed steps from re-executing](#keep-sealed-steps-from-re-executing)
before driving one.

## Fork the run

```ts
import { FlowEngine } from "@smthrs/engine"
import { TimeTravel } from "@smthrs/time-travel"
import * as Effect from "effect/Effect"

const program = Effect.gen(function*() {
  const timeTravel = yield* TimeTravel
  return yield* timeTravel.fork({
    runId: "analyse-1",
    frame: { lineageId: FlowEngine.Lineage.root("analyse-1"), seq: 12 }
  })
})
```

The result names the child run, the lineage edge back to the parent frame, and
everything the boundary assessment disclosed:

```ts
interface ForkResult {
  readonly runId: string
  readonly edge: Frame.LineageEdge
  readonly warnings: ReadonlyArray<string>
}
```

## What the child inherits

The fork copies the journal prefix at or below the frame, the frame's
anchors, and only the attempts that prefix can explain. An attempt that started
after the frame is not part of the history the child inherits, which is what
makes the child's past a real prefix of the parent's rather than a snapshot of
the parent's present.

The child also records its own origin on its journal, under
`Frame.forkCreatedEventType`, carrying the parent run id and the parent
sequence the fork was taken at. A forensic walk can start from the child and go
back without consulting the edge table.

The parent is never mutated and keeps running.

## The workspace is derived, not supplied

The fork mints the child run id first and names the Jujutsu lane after it:
`smithers-fork-`, the sanitized child id capped at 64 characters, then a short
digest of the raw id. The lane and the run it holds therefore carry one
identity, and a frame forked twice gets two lanes rather than a collision.

The child's worktree is checked out at the frame's recorded pointer, not at the
parent's current tree.

`ForkOptions.workspaceRoot` only moves which directory the derived name lands
in. It defaults to `.flows/forks`:

```ts
yield * timeTravel.fork(position, { workspaceRoot: ".worktrees/forks" })
```

By default, the lane is forgotten when the time-travel service's scope is released,
not when the call returns. Set `retainWorkspace: true` to keep the lane registered
for a later process; the caller then owns its cleanup. `forkWorkspaceName(childRunId)`
from `@smthrs/time-travel/TimeTravel` returns the derived workspace name.
If the frame has no recorded anchor, the fork still
succeeds and reports a warning naming the workspace it could not restore.

## Warnings are disclosure, not refusal

A fork never compensates anything, so its boundary assessment cannot block. Every
blocking and revertible verdict is normalized to a warning that says what it
means: this effect may execute again on the child.

A fork with a non-empty `warnings` is a successful fork. Read the warnings and
decide whether to drive the child; the copy already exists either way.

## Keep sealed steps from re-executing

**Fork replay limitation:** copied attempt rows retain their parent digests.
Actions whose keys include the run ID execute again in the child, including
compensable and irreversible actions. An explicitly shared cache environment
can reuse eligible sealed results, but copied attempts alone do not make the
prefix replayable. Make repeated external effects idempotent before driving a
fork.

A sealed action's cache key is computed under the ambient cache environment.
With no declaration, the engine scopes the key to the execution that produced
it, so the child addresses a different key and re-executes the step instead of
replaying it. Declaring the environment is what lets a sealed identity cross
the fork boundary:

```ts
import { Action } from "@smthrs/flow"

const environment = Action.layerCacheEnvironment({ layers: [], capabilities: {} })
```

Provide it in both compositions, the one that produced the parent and the one
that drives the child.

## Drive the child

The child is an ordinary run. Execute the same flow with the forked run id as
its execution id. Run-scoped prefix actions execute again; eligible sealed
results can be reused under the shared cache environment described above:

```ts
const driven = Effect.gen(function*() {
  const timeTravel = yield* TimeTravel
  const fork = yield* timeTravel.fork(position)
  return yield* Analyse.execute({}, { executionId: fork.runId })
})
```

A runnable version of this walkthrough is
[`05-time-travel-fork.ts`](https://github.com/smithersai/smithers/blob/main/examples/src/05-time-travel-fork.ts)
in the Smithers examples on GitHub.

## Bound what the fork reads

`ForkOptions.maxHistoryEntries` caps the suffix the fork assesses for this one
call, overriding the service default. A suffix past the cap fails
`limit_exceeded`.

## Failures

| Code             | Cause                                                                                                     |
| ---------------- | --------------------------------------------------------------------------------------------------------- |
| `live_parent`    | The parent run, or an ancestor of it, is running, claimed, or owned, so it has no settled prefix to copy. |
| `not_found`      | The frame addresses no record of that run.                                                                |
| `invalid`        | A malformed option, or a durable payload that does not decode.                                            |
| `limit_exceeded` | The suffix the fork would assess is longer than the cap allows.                                           |
| `unknown`        | The store, the journal, or Jujutsu failed. The cause is attached.                                         |

If the process dies after the lane is provisioned and before the store commits
the fork, the next build of `TimeTravel.layer` forgets the lane and the
reserved ordinal is never handed out again, so a retry lands under a fresh
name.

## Where to go next

- [Frames and lineage](/concepts/frames-and-lineage/): the edge a fork
  records, and what `attached` means for a later rewind.
- [Effect tiers](/concepts/effect-tiers/): how each warning was reached.
- [Rewind a run to a frame](/guides/rewind-a-run/): the destructive counterpart.
