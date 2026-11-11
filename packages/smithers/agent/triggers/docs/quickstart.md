---
title: "Quickstart"
description: "Register a durable trigger and watch the scheduler launch it: a SQLite store, a recording runner, and a test clock that crosses two schedule boundaries in milliseconds."
sidebar:
  order: 2
---

This quickstart takes one trigger from a declaration to a launched run. The
store is the production SQLite one and the scheduler is the production one;
only two things are substituted, and both are seams the package already has:
the `Runner` records launches instead of reaching a control plane, and the
Effect `Clock` is a test clock, so a nightly schedule crosses two boundaries in
milliseconds instead of two days. Each step below is TypeScript; the
[VibeLang tab](#the-same-walkthrough-in-vibelang) runs the same steps as Effect
code.

By the end you will have a trigger row that remembers when it last fired, and
one launch carrying an idempotency key derived from the occurrence.

## Prerequisites

- Node.js 22.19.0 or later.
- A TypeScript project that depends on `@smthrs/triggers` and
  `@smthrs/database`. See [Installation](./installation.md).

## Compose the store, the runner, and the clock

Create `quickstart.ts`. `SqlTriggerStore.layer` needs a SQL client and a
durable writer, and it runs its own migrations when it builds:

```ts
import * as DurableWriter from "@smthrs/database/DurableWriter"
import * as NodeDatabase from "@smthrs/database/node/NodeDatabase"
import * as Scheduler from "@smthrs/triggers/Scheduler"
import * as SqlTriggerStore from "@smthrs/triggers/SqlTriggerStore"
import * as TriggerStore from "@smthrs/triggers/TriggerStore"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import { TestClock } from "effect/testing"

const launched: Array<Scheduler.StartInput> = []

const database = Layer.provideMerge(
  DurableWriter.layer(),
  NodeDatabase.layer({ filename: ":memory:" })
)

/** The launcher seam: record the launch and answer with a run id. */
const runner = Scheduler.layerNoopRunner({
  start: (input) =>
    Effect.sync(() => {
      launched.push(input)
      return input.idempotencyKey
    })
})

const layer = Layer.mergeAll(
  SqlTriggerStore.layer.pipe(Layer.provide(database)),
  runner,
  TestClock.layer()
)
```

`Scheduler.layerNoopRunner` answers `inspect` with `"completed"` and `cancel`
with nothing, so a launch settles the moment it starts. The override replaces only
`start`.

## Register the trigger and run two ticks

`Scheduler.make` builds a scheduler with no supervisor fiber, so the program
decides when a tick happens. That is what makes the walkthrough deterministic:

```ts
const program = Effect.scoped(Effect.gen(function*() {
  const triggers = yield* TriggerStore.TriggerStore
  yield* triggers.register({
    id: "nightly-report",
    flowId: "reports/nightly",
    input: { channel: "#ops" },
    cron: "0 3 * * *",
    timezone: "UTC",
    overlap: "skip",
    catchUp: "one",
    maxCatchUp: 1,
    enabled: true
  })

  const scheduler = yield* Scheduler.make()

  // First sight of this trigger: the tick records where the clock is and
  // fires nothing, because a trigger that has never fired owes no history.
  yield* TestClock.setTime(Date.parse("2026-03-01T03:00:00.000Z"))
  yield* scheduler.runOnce

  // A boundary has passed since that watermark, so this tick launches it.
  yield* TestClock.setTime(Date.parse("2026-03-02T03:00:00.000Z"))
  yield* scheduler.runOnce
  yield* Effect.yieldNow

  return yield* triggers.get("nightly-report")
}))

const registered = await Effect.runPromise(program.pipe(Effect.provide(layer)))
console.log(launched)
console.log(registered)
```

Run the file with your TypeScript runner. The recorded launch and the stored
row look like this:

```text
[
  {
    flowId: 'reports/nightly',
    input: { channel: '#ops' },
    idempotencyKey: 'nightly-report:2026-03-02T03:00:00.000Z'
  }
]
{
  _id: 'Option',
  _tag: 'Some',
  value: {
    id: 'nightly-report',
    flowId: 'reports/nightly',
    input: { channel: '#ops' },
    cron: '0 3 * * *',
    timezone: 'UTC',
    overlap: 'skip',
    catchUp: 'one',
    maxCatchUp: 1,
    enabled: true,
    revision: 1,
    lastFiredAt: 1772420400000
  }
}
```

## What just happened

Four facts in that output are the package working.

- **The first tick fired nothing.** A trigger registered on Sunday evening does
  not owe Monday morning six days ago. With no `lastFiredAt`, the first tick a
  process sees establishes a watermark at the latest boundary and starts from
  the next one.
- **The idempotency key is the occurrence, not the moment.** It is
  `<triggerId>:<occurrence ISO instant>`, computed from the schedule boundary
  with milliseconds zeroed. Two hosts that both notice the same boundary derive
  the same key, so a duplicate launch is the same launch.
- **`revision` is 1.** Every registration of the same id bumps the revision, and
  a claim carries the revision it was computed from. That is the fence that
  stops a stale snapshot from firing a trigger somebody just edited.
- **`lastFiredAt` is the occurrence that fired**, not the wall time the host
  noticed it. It is the cursor catch-up resumes from, and it only ever moves
  forward, so an older run settling after a newer occurrence was skipped cannot
  drag it backwards and replay settled work.

## The same walkthrough in VibeLang

In [VibeLang](https://github.com/smithersai/vibelang) the walkthrough is an
`effect` function: `try` runs each store, clock, and scheduler call, and a
`provide` block supplies the store, the recording runner, and the test clock.
`main` hands the runner its own `launched` array, so each run starts with an
empty record. The launch and the stored row are the ones above.

This is `examples/vibelang/quickstart.vibe`. `test/quickstart.test.vibe` runs it, and
the package's docs check fails if this block and the file differ.

```vibe
import * as DurableWriter from "@smthrs/database/DurableWriter"
import * as NodeDatabase from "@smthrs/database/node/NodeDatabase"
import * as Scheduler from "@smthrs/triggers/Scheduler"
import * as SqlTriggerStore from "@smthrs/triggers/SqlTriggerStore"
import * as TriggerStore from "@smthrs/triggers/TriggerStore"
import { TestClock } from "effect/testing"

const database = Layer.provideMerge(DurableWriter.layer(), NodeDatabase.layer({ filename: ":memory:" }))

/** The production store, a runner that records each launch, and a test clock. */
export const layer = (launched: Array<Scheduler.StartInput>) =>
  Layer.mergeAll(
    Layer.provide(SqlTriggerStore.layer, database),
    // The launcher seam: record the launch and answer with a run id.
    Scheduler.layerNoopRunner({
      start: (input) =>
        sync(() => {
          launched.push(input)
          return input.idempotencyKey
        })
    }),
    TestClock.layer()
  )

/** Registers a nightly trigger, then ticks across two schedule boundaries. */
export effect function registerAndTick() {
  const triggers = try TriggerStore.TriggerStore
  try triggers.register({
    id: "nightly-report",
    flowId: "reports/nightly",
    input: { channel: "#ops" },
    cron: "0 3 * * *",
    timezone: "UTC",
    overlap: "skip",
    catchUp: "one",
    maxCatchUp: 1,
    enabled: true
  })

  const scheduler = try Scheduler.make()

  // First sight of this trigger: the tick records a watermark and fires nothing.
  try TestClock.setTime(Date.parse("2026-03-01T03:00:00.000Z"))
  try scheduler.runOnce

  // A boundary has passed since that watermark, so this tick launches it.
  try TestClock.setTime(Date.parse("2026-03-02T03:00:00.000Z"))
  try scheduler.runOnce
  try yieldNow

  return try triggers.get("nightly-report")
}

/** Runs the walkthrough and answers the recorded launches and the stored row. */
export effect function main() {
  const launched: Array<Scheduler.StartInput> = []
  const registered = try scoped(effect {
    provide layer(launched) {
      return try registerAndTick()
    }
  })
  return { launched, registered }
}
```

## Next steps

- [Run the scheduler in a host](./guides/run-the-scheduler.md): the same
  composition with a supervisor fiber and the real Control-backed runner.
- [Choose an overlap and catch-up policy](./guides/choose-a-policy.md): what
  `skip` and `one` decided here, and when to pick something else.
- [The claim protocol](./concepts/claim-protocol.md): how hosts coordinate
  claims and runners deduplicate repeated launch attempts.
