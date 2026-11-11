---
title: "Quickstart"
description: "Drive one run through its whole durable lifecycle: create, claim, activate, record a step attempt, finish it, and settle the run, against an in-memory database."
sidebar:
  order: 2
---

This quickstart takes one run from `pending` to `completed` and records a step
attempt along the way. The stores are the production ones. Only the database is
in memory, so the script runs with no files and no configuration. Each step
below is TypeScript; the [VibeLang tab](#the-same-walkthrough-in-vibelang) runs
the same lifecycle as `effect` functions.

By the end you will have used every operation the durable engine uses on a
normal run, and read back the row a restart would have found.

## Prerequisites

- Node.js 22.19.0 or later.
- The package installed: `npm install @smthrs/run-store@next effect`.

## Name the owner

An owner identity is the fence on every write this process makes. It is three
fields, and all three are compared in the same SQL statement as the mutation
they guard:

```ts
import type { OwnerId } from "@smthrs/run-store/Ownership"

const owner: OwnerId = { hostId: "quickstart-host", pid: 4102, nonce: "3f9c-8b21" }
```

`hostId` says which machine, `pid` says which process, and `nonce` distinguishes
one incarnation of that process from the next. A production host mints this
through `OwnerIdentity` in [`@smthrs/engine-store`](/api/engine-store) rather
than writing it down.

## Create the run and claim it

`create` inserts a `pending` row whose `stateJson` is the executable state a
resume would re-enter. Claiming is two phase: `claim` reserves the row, and
`activate` turns the reservation into ownership.

```ts
import { RunStore } from "@smthrs/run-store"
import * as Clock from "effect/Clock"
import * as Effect from "effect/Effect"

const claimRun = Effect.gen(function*() {
  const runs = yield* RunStore.RunStore

  yield* runs.create("quickstart-1", JSON.stringify({ cursor: 0 }))

  const pending = yield* runs.get("quickstart-1")
  const expected = {
    status: pending.status,
    owner: pending.owner,
    heartbeatAtMs: pending.heartbeatAtMs
  }

  const nowMs = yield* Clock.currentTimeMillis
  const claim = yield* runs.claim("quickstart-1", expected, owner, nowMs)
  if (claim._tag !== "Claimed") return yield* Effect.die(`claim lost: ${claim._tag}`)

  const activation = yield* runs.activate("quickstart-1", owner, claim.claimedAtMs, expected)
  if (activation._tag !== "Activated") return yield* Effect.die(`activation lost: ${activation._tag}`)
})
```

`expected` is the row you just read, restated as the three fields a claim
guards. The compare-and-swap admits the write only while the row still matches,
so a peer that claimed the run between your read and your write loses the race
instead of overwriting it.

## Record a step attempt

An attempt is addressed by `(runId, stepKeyDigest, attempt)` and is fenced on
the run you own. `put` starts it, `heartbeat` proves it is still moving and
saves a checkpoint, and `finish` records how it ended:

```ts
import { AttemptStore } from "@smthrs/run-store"

const runStep = Effect.gen(function*() {
  const attempts = yield* AttemptStore.AttemptStore
  const startedAtMs = yield* Clock.currentTimeMillis

  yield* attempts.put({
    runId: "quickstart-1",
    stepKeyDigest: "step-fetch",
    attempt: 0,
    state: "running",
    startedAtMs,
    meta: { step: "fetch" }
  }, owner)

  yield* attempts.heartbeat(
    "quickstart-1",
    "step-fetch",
    0,
    owner,
    yield* Clock.currentTimeMillis,
    { cursor: 1 }
  )

  yield* attempts.finish({
    runId: "quickstart-1",
    stepKeyDigest: "step-fetch",
    attempt: 0,
    state: "completed",
    finishedAtMs: yield* Clock.currentTimeMillis,
    outcome: { rows: 12 }
  }, owner)
})
```

The sixth argument to `heartbeat` is a checkpoint: the value the step would
resume from. Every attempt value crosses an admission boundary that copies it as
inert JSON before persistence can yield, so a getter, a cycle, or a `toJSON`
method is refused rather than persisted. See
[Durable values](./concepts/durable-values.md).

## Settle the run

`transitionOwned` is the only way to move a run you own. A terminal target
clears the owner, the heartbeat, and any claim, and stamps `finished_at_ms`:

```ts
const settleRun = Effect.gen(function*() {
  const runs = yield* RunStore.RunStore
  const outcome = yield* runs.transitionOwned(
    "quickstart-1",
    owner,
    "completed",
    JSON.stringify({ cursor: 1 })
  )
  if (outcome._tag !== "Transitioned") return yield* Effect.die(`fence lost: ${outcome._tag}`)
  return yield* runs.get("quickstart-1")
})
```

## Run it

`TestRunStore.layer` provides both stores over a fresh in-memory SQLite
database with the migrations already applied:

```ts
import * as TestRunStore from "@smthrs/run-store/test/TestRunStore"

const main = claimRun.pipe(
  Effect.andThen(runStep),
  Effect.andThen(settleRun),
  Effect.provide(TestRunStore.layer),
  Effect.scoped
)

console.log(await Effect.runPromise(main))
```

Run the file with your TypeScript runner. The settled row prints with its owner
cleared and both lifecycle stamps written:

```text
{
  runId: 'quickstart-1',
  status: 'completed',
  createdAtMs: 1757000000000,
  startedAtMs: 1757000000000,
  finishedAtMs: 1757000000004,
  owner: null,
  heartbeatAtMs: null,
  claim: null,
  claimedAtMs: null,
  parentRunId: null,
  cancelRequestedAtMs: null,
  lineageId: null,
  roundOrdinal: null,
  stateJson: '{"cursor":1}'
}
```

## What just happened

The run row moved `pending` to `running` to `completed`, and every write on the
way was admitted only because the full `(hostId, pid, nonce)` fence still
matched the row. Had a second process taken the run over between your
`activate` and your `transitionOwned`, the transition would have reported
`FenceLost` and changed nothing: the fence is compared in the same statement as
the mutation, so there is no window between the check and the write.

The `stateJson` you passed to `transitionOwned` is what a restart would
re-enter. It is stored and returned byte for byte, with nothing rewritten in
between.

## The same walkthrough in VibeLang

In [VibeLang](https://github.com/smithersai/vibelang) each stage is an `effect`
function and `try` runs each store call. A compare-and-swap that does not admit
the write fails with a typed `RaceLost` through `throw` instead of a defect, so
a caller can `catch` it and `match` on the step that lost. One `provide` block
supplies `TestRunStore.layer` to the whole lifecycle.

This is `examples/vibe/quickstart.vibe`. `test/quickstart.test.vibe` runs it, and
the package's docs check fails if this block and the file differ.

```vibe
import { AttemptStore, RunStore } from "@smthrs/run-store"
import type { OwnerId } from "@smthrs/run-store/Ownership"
import * as TestRunStore from "@smthrs/run-store/test/TestRunStore"

/** The fence on every write this process makes. */
export const owner: OwnerId = { hostId: "quickstart-host", pid: 4102, nonce: "3f9c-8b21" }

/** A compare-and-swap that did not admit the write, named by its outcome. */
export error RaceLost { step: string; outcome: string }

/** Creates the run, reserves it, and turns the reservation into ownership. */
export effect function claimRun(runId: string, by: OwnerId) {
  const runs = try RunStore.RunStore
  try runs.create(runId, `{"cursor":0}`)
  const pending = try runs.get(runId)
  const expected = { status: pending.status, owner: pending.owner, heartbeatAtMs: pending.heartbeatAtMs }

  const claim = try runs.claim(runId, expected, by, try Clock.currentTimeMillis)
  if (claim._tag !== "Claimed") throw new RaceLost({ step: "claim", outcome: claim._tag })
  const activation = try runs.activate(runId, by, claim.claimedAtMs, expected)
  if (activation._tag !== "Activated") throw new RaceLost({ step: "activate", outcome: activation._tag })
}

/** Starts one step attempt, checkpoints it, and records how it ended. */
export effect function runStep(runId: string, by: OwnerId) {
  const attempts = try AttemptStore.AttemptStore
  const id = { runId, stepKeyDigest: "step-fetch", attempt: 0 }
  try attempts.put({ ...id, state: "running", startedAtMs: try Clock.currentTimeMillis, meta: { step: "fetch" } }, by)
  try attempts.heartbeat(runId, "step-fetch", 0, by, try Clock.currentTimeMillis, { cursor: 1 })
  try attempts.finish({ ...id, state: "completed", finishedAtMs: try Clock.currentTimeMillis, outcome: { rows: 12 } }, by)
}

/** Moves the owned run to `completed`; only the full owner fence admits it. */
export effect function settleRun(runId: string, by: OwnerId) {
  const runs = try RunStore.RunStore
  const outcome = try runs.transitionOwned(runId, by, "completed", `{"cursor":1}`)
  if (outcome._tag !== "Transitioned") throw new RaceLost({ step: "settle", outcome: outcome._tag })
  return try runs.get(runId)
}

/** The whole lifecycle against the production stores over an in-memory database. */
export effect function quickstart(settledBy: OwnerId = owner) {
  provide TestRunStore.layer {
    try claimRun("quickstart-1", owner)
    try runStep("quickstart-1", owner)
    const settled = try settleRun("quickstart-1", settledBy)
    const attempt = try (try AttemptStore.AttemptStore).get({ runId: "quickstart-1", stepKeyDigest: "step-fetch", attempt: 0 })
    return { settled, attempt }
  }
}
```

## Next steps

- [Claim a run and finish it](./guides/claim-and-finish-a-run.md): the same
  lifecycle with heartbeat supervision and the atomic single-call form.
- [Fencing and ownership](./concepts/fencing.md): why every refused write is a
  named outcome instead of an error.
- [Test against the real stores](./guides/testing.md): the layer used here,
  turned into a test habit.
