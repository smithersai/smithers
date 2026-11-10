---
title: "Rewind a run to a frame"
description: "Rewind a paused run to an earlier frame and resume it, fork a finished run instead, and read the detached-child policy, the result, the audit row, and every way a rewind refuses."
sidebar:
  order: 3
---

A rewind removes everything a run recorded after a frame, compensating the side
effects it crosses on the way. It is the one destructive operation in this
package, and the only one that takes the run away from whoever is driving it.

## Paused runs rewind; finished runs fork

A rewind is a writer. It claims the run's ownership like any driver, so it
takes only an idle run: `pending`, or `suspended` at a durable wait such as
`DurableDeferred.await`. A parked run rewinds, and when it resumes, every step
above the frame runs again.

A finished run (`completed`, `failed`, or `cancelled`) is never idle again, and
a rewind refuses it with `TimeTravelError` code `busy`:
`run <id> is not available for rewind`. Fork it instead. A fork copies the
history at or below the frame into a new child run, leaves the parent as it is,
and the child runs everything above the frame.

## Try it

The program below parks a two-step run on a person's approval, rewinds it,
approves it, then shows the refusal and the fork. It needs jj 0.39.0 or later
on `PATH`, because the fork adds its workspace through jj. Every output block is real output from
`@smthrs/flows`, `@smthrs/time-travel`, and `@smthrs/jj` 1.0.0-rc.6.

```bash
mkdir rewind && cd rewind
npm init -y && npm pkg set type=module
npm install @smthrs/platform-node@next @smthrs/flows@next effect
npm install @smthrs/time-travel@1.0.0-rc.17 @smthrs/jj@1.0.0-rc.17
jj git init workspace
```

`@smthrs/platform-node` supplies `NodeRuntime`, the Node host the program runs
the engine on. `@smthrs/time-travel` supplies `SqlTimeTravelStore`, which
`@smthrs/flows` does not re-export. `@smthrs/jj` supplies `NodeJj`, the `Jj` service backed by the jj
CLI: a fork adds the child's workspace through it, and a rewind restores the
workspace through it when it crosses a `compensable` step. Install both at the
version of `@smthrs/flows` you have. The workspace must be a jj repository.

Create `rewind.ts`:

```ts
import { Action, DurableDeferred, Engine, Flow, Interpreter, Journal, Plan, RunStore, TimeTravel } from "@smthrs/flows"
import * as NodeJj from "@smthrs/jj/node/NodeJj"
import { NodeRuntime } from "@smthrs/platform-node"
import { SqlTimeTravelStore } from "@smthrs/time-travel"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as Layer from "effect/Layer"
import * as Schema from "effect/Schema"
import { resolve } from "node:path"

const Draft = Action.make("release/Draft", { payload: { issue: Schema.String }, success: Schema.String })
const Ship = Action.make("release/Ship", { payload: { draft: Schema.String }, success: Schema.String })

/** A person's approval: the durable wait that parks the run. */
const Approval = DurableDeferred.make("release/approval", { success: Schema.String })

const Release = Flow.make("release/Release", {
  payload: { issue: Schema.String },
  success: Schema.String,
  body: (input) => Draft.call(input).pipe(Plan.Node.bindPlanned((draft) => Ship.call({ draft })))
})

const steps = Interpreter.layer(Release).pipe(
  Layer.provideMerge(Draft.toLayer(({ issue }) =>
    Effect.sync(() => {
      console.log("ran Draft")
      return `draft for ${issue}`
    })
  )),
  Layer.provideMerge(Ship.toLayer(({ draft }) =>
    Effect.gen(function*() {
      const approval = yield* DurableDeferred.await(Approval)
      return `${draft}, ${approval}`
    })
  )),
  Layer.provideMerge(Action.layerImplementations)
)

const workspaceRoot = resolve("workspace")
const host = NodeRuntime.layerHost(
  { filename: `${workspaceRoot}/.flows/engine.db`, workspaceRoot, owner: { hostId: "release" } },
  steps
)

/** Time travel over the host's database, with the jj CLI bound to the workspace. */
const layer = TimeTravel.layer.pipe(
  Layer.provideMerge(SqlTimeTravelStore.layer),
  Layer.provideMerge(NodeJj.layerAt(workspaceRoot)),
  Layer.provideMerge(host)
)

const at = (runId: string, seq: number) => ({
  runId,
  frame: { lineageId: Engine.FlowEngine.Lineage.root(runId), seq }
})

const status = (runId: string) =>
  Effect.gen(function*() {
    const runs = yield* RunStore.RunStore.RunStore
    console.log(`run ${runId}: ${(yield* runs.get(runId)).status}`)
  })

/** Drives a run until it parks on the approval. */
const driveUntilParked = (runId: string) =>
  Effect.gen(function*() {
    yield* Effect.forkScoped(Release.execute({ issue: "#7" }, { executionId: runId }))
    const runs = yield* RunStore.RunStore.RunStore
    while (true) {
      yield* Effect.sleep("50 millis")
      const run = yield* Effect.option(runs.get(runId))
      if (run._tag === "Some" && run.value.status === "suspended") return
    }
  })

const [command, arg] = process.argv.slice(2)

const program = Effect.gen(function*() {
  const timeTravel = yield* TimeTravel
  switch (command) {
    case "start": {
      yield* driveUntilParked("release-1")
      return yield* status("release-1")
    }
    case "journal": {
      const journal = yield* Journal.Journal.Journal
      yield* journal.flush
      const page = yield* journal.entries({ runId: Journal.JournalEvent.RunId.make("release-1"), limit: 200 })
      for (const entry of page.entries) console.log(`seq ${entry.seq} ${entry.eventType}`)
      return
    }
    case "rewind": {
      const result = yield* Effect.result(timeTravel.rewind(at("release-1", Number(arg))))
      if (result._tag === "Failure") return console.log(`refused ${result.failure.code}: ${result.failure.message}`)
      console.log(`rewound to seq ${result.success.frame.seq}, archived ${result.success.archive.archived} entries`)
      return yield* status("release-1")
    }
    case "approve": {
      const runId = arg ?? "release-1"
      const token = DurableDeferred.tokenFromExecutionId(Approval, { flow: Release, executionId: runId })
      yield* DurableDeferred.done(Approval, { token, exit: Exit.succeed("approved") })
      console.log(yield* Release.execute({ issue: "#7" }, { executionId: runId }))
      return yield* status(runId)
    }
    case "fork": {
      const child = yield* timeTravel.fork(at("release-1", Number(arg)))
      console.log(`forked ${child.runId}`)
      yield* driveUntilParked(child.runId)
      return yield* status(child.runId)
    }
  }
})

await Effect.runPromise(program.pipe(Effect.provide(layer), Effect.scoped))
```

`Draft` runs and returns; `Ship` waits for the approval. Start the run:

```bash
node rewind.ts start
```

```text
ran Draft
run release-1: suspended
```

Print the journal to choose a frame:

```bash
node rewind.ts journal
```

```text
seq 0 flows.engine.run-decision
seq 1 flows.engine.run-decision
seq 2 flows.engine.run-decision
seq 3 flows.engine.plan-recorded
seq 4 flows.engine.node-scheduled
seq 5 flows.engine.node-scheduled
seq 6 flows.engine.node-scheduled
seq 7 flows.engine.attempt-started
seq 8 flows.engine.snapshot-identified
seq 9 flows.engine.attempt-finished
seq 10 flows.engine.node-settled
seq 11 flows.engine.node-scheduled
seq 12 flows.engine.attempt-started
seq 13 flows.engine.snapshot-identified
seq 14 flows.engine.run-decision
```

`Draft`'s attempt starts at seq 7, so seq 6 is the frame just before it. Rewind
the paused run there:

```bash
node rewind.ts rewind 6
```

```text
rewound to seq 6, archived 8 entries
run release-1: suspended
```

Approve it. The run resumes from seq 6, so `Draft` runs again before `Ship`
reads the approval:

```bash
node rewind.ts approve
```

```text
ran Draft
draft for #7, approved
run release-1: completed
```

The run has finished, so the same rewind is now refused:

```bash
node rewind.ts rewind 6
```

```text
refused busy: run release-1 is not available for rewind
```

Fork it at the same frame instead. The child inherits seq 0 to 6, runs `Draft`,
and parks at its own approval:

```bash
node rewind.ts fork 6
```

```text
forked release-1:fork:6:1
ran Draft
run release-1:fork:6:1: suspended
```

```bash
node rewind.ts approve release-1:fork:6:1
```

```text
draft for #7, approved
run release-1:fork:6:1: completed
```

`release-1` stays `completed` with its own history.
[Fork a run at a frame](./fork-a-run.md) covers what a child inherits and where
its workspace goes.

## Rewind

The call takes the same position a replay and a fork take:

```ts
import { Engine, TimeTravel } from "@smthrs/flows"
import * as Effect from "effect/Effect"

const program = Effect.gen(function*() {
  const timeTravel = yield* TimeTravel
  return yield* timeTravel.rewind({
    runId: "release-1",
    frame: { lineageId: Engine.FlowEngine.Lineage.root("release-1"), seq: 6 }
  })
})
```

The ownership claim, the audit id, the heartbeat, and the compensation-handler
registry are all wired inside the service. None of them is a parameter.

The result is the accounting:

| Field               | What it holds                                                      |
| ------------------- | ------------------------------------------------------------------ |
| `auditId`           | The audit row this rewind wrote. Read it back for the full detail. |
| `frame`             | The frame the run was truncated to.                                |
| `archive.archived`  | How many journal records were moved into the archive.              |
| `archive.orphaned`  | The lineage edges left pointing at history that no longer exists.  |
| `assessments`       | Every crossed effect and the verdict it was given.                 |
| `warnings`          | Terminal detached children that survive the truncation.            |
| `cancelledChildren` | The children the policy cancelled, in the order they landed.       |

Records are archived, not deleted: they move aside so a forensic reader can
still reach them. Archive rows are keyed by `(run_id, generation, seq)`, using
the journal generation before truncation advances it. Reused sequences retain
each discarded history. Snapshot anchors above the frame and all anchors of
archived attached children are removed in the same transaction.

After the truncation the run is suspended carrying the state
derived at the frame, not the state its truncated future had left on the row.
Deferred completions and clock deadlines whose journal records moved into the
archive are removed atomically with that truncation. If the resumed run reaches
the same deferred or timer again, it waits again instead of consuming the
discarded future's value or deadline.

## Choose what happens to detached children

`RewindOptions.detachedChildren` is the one policy decision the caller makes:

```ts
import { TimeTravel } from "@smthrs/flows"
import type { Position } from "@smthrs/time-travel"
import * as Effect from "effect/Effect"

const rewindCancellingChildren = (position: Position) =>
  Effect.gen(function*() {
    const timeTravel = yield* TimeTravel
    return yield* timeTravel.rewind(position, { detachedChildren: "cancel" })
  })
```

- `"block"`, the default: a live detached child refuses the rewind rather than
  being cancelled behind the operator's back.
- `"cancel"`: the rewind cancels idle (`pending` or `suspended`) detached
  children and running detached children whose owner lease has expired, after
  the commit point, and lists them in `cancelledChildren`. A running child
  whose owner is still live refuses with `live_child`. `Options.isAlive` may
  veto cancellation even after the lease expires.

An **attached** child is not covered by this option at all. It still depends on
the history being truncated, so a live one always refuses the rewind with
`live_child`. Detach it or let it finish first.

The value is decoded before anything durable happens. A misspelled
`"blcok"` is refused `invalid` rather than falling through to the destructive
branch.

## Bound the read

`pageSize` sets the journal page size for the suffix scan. `maxHistoryEntries`
caps the suffix the rewind may truncate for this one call, and a longer suffix
is refused `limit_exceeded` **before** the run is claimed, so an oversized
rewind never takes the run away from anyone.

## Read the audit row back

The audit row is the durable record of the attempt, and it outlives the call:

```ts
import * as Effect from "effect/Effect"
import * as SqlClient from "effect/sql/SqlClient"

/** `auditId` is the field of the same name on the rewind's result. */
const auditStatus = (auditId: string) =>
  Effect.gen(function*() {
    const sql = yield* Effect.service(SqlClient.SqlClient)
    return yield* sql<{ readonly status: string }>`
      SELECT status FROM flows_time_travel_audits WHERE id = ${auditId}
    `
  })
```

`status` is `in_progress`, `completed`, or `failed`. Its `detail` column
carries the phase the protocol reached, the suffix it measured, the target
pointer, the compensation receipts, the warnings, and the children it cancelled
or still owes a cancellation.

A runnable version of this walkthrough is
[`06-time-travel-rewind.ts`](https://github.com/smithersai/smithers/blob/main/packages/smithers/flows/examples/06-time-travel-rewind.ts)
in the Smithers examples on GitHub.

## Failures

| Code                  | Cause                                                                                                                |
| --------------------- | -------------------------------------------------------------------------------------------------------------------- |
| `busy`                | Another owner holds the run, the journal tail moved under the claim, or ownership was lost before the end.           |
| `live_child`          | An attached descendant is still executing, or a detached child is blocked by policy or owner liveness.               |
| `not_found`           | The run, the frame, or the audit addresses nothing.                                                                  |
| `invalid`             | A malformed option, or a durable payload that does not decode. Refused before anything is touched.                   |
| `rate_limited`        | The `Options.rateLimit` limiter the service was built with rejected the attempt. The audit row records the decision. |
| `irreversible`        | A crossed effect cannot be undone: no handler, or a sealed result whose cache entry is gone.                         |
| `compensation_failed` | A rollback handler or the workspace restore failed, so the rewind stopped rather than half revert.                   |
| `fence_lost`          | Ownership of the run or of an attached child was superseded before the commit, so nothing was written.               |
| `limit_exceeded`      | The suffix is longer than the cap allows. Raised before the run is claimed.                                          |
| `unknown`             | The store, the journal, or an unmapped host failure. The cause is attached.                                          |

If a rewind fails after claiming the run but before commit, successful rollback
restores the saved run state and releases ownership as `suspended`, including
when the run was originally
`pending`. Startup recovery uses the same restoration rule. The audit closes
as `failed` after restoration succeeds. If ownership cannot be released, the
audit stays `in_progress` for recovery; the error keeps its original code and
attaches the restoration problem as its cause. See
[The rewind protocol](../concepts/rewind-protocol.md) for where each step sits
relative to that point, and what a crash between them costs.

## Where to go next

- [Fork a run at a frame](./fork-a-run.md): what a child run inherits, and
  where its workspace goes.
- [The rewind protocol](../concepts/rewind-protocol.md): the ordered protocol
  and its crash behaviour.
- [Compensate an irreversible effect](./compensate-an-effect.md): turning an
  `irreversible` refusal into a rewind that succeeds.
- [Troubleshooting](../troubleshooting.md): each refusal, and what to change.
