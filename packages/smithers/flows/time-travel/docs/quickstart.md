---
title: "Quickstart"
description: "Start a durable run on NodeRuntime.layerHost, park it at a durable wait, compose the time-travel service onto the same database, address a frame, and fold the run's journal into an answer."
sidebar:
  order: 2
---

This quickstart replays a run from its own history. You start an ordinary
durable flow, leave it parked at a durable wait, and then fold the journal it
wrote into a number. Nothing is stubbed except the version-control service,
which replay never calls.

By the end you will have the two things every other operation needs: a
composition that provides `TimeTravel`, and a `Position` that addresses a point
in a run's past. Every output block below is real output from
`@smthrs/flows` and `@smthrs/time-travel` 1.0.0-rc.6.

## Prerequisites

- Node.js 22.19.0 or later. It runs the TypeScript file below directly.

This page only replays, so it does not need jj. Forking does, and so does a
rewind that restores a compensable step's files; see
[Rewind a run to a frame](./guides/rewind-a-run.md).

Create a project and install the engine, its Node host, `effect`, and this
package:

```bash
mkdir time-travel-quickstart && cd time-travel-quickstart
npm init -y && npm pkg set type=module
npm install @smthrs/platform-node@next @smthrs/flows@next effect
npm install @smthrs/time-travel@1.0.0-rc.17
```

`@smthrs/flows` carries the durable engine and re-exports the `TimeTravel`
service key, but not a store. `@smthrs/platform-node` supplies `NodeRuntime`,
the Node host the program runs the engine on. `@smthrs/time-travel` supplies
`SqlTimeTravelStore`; install it at the version of `@smthrs/flows` you have, so
both resolve to one copy of the service key.

## Declare a run worth replaying

Create `quickstart.ts`. The flow credits an amount and then posts the entry,
and posting waits on a durable deferred. That wait is what leaves the run
suspended with its history committed rather than finished:

```ts
import { Action, DurableDeferred, Flow, Plan } from "@smthrs/flows"
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"

/** Two recorded steps: credit an amount, then post the entry once it settles. */
const Credit = Action.make("ledger/Credit", { payload: { amount: Schema.Number }, success: Schema.Number })
const Post = Action.make("ledger/Post", { payload: { balance: Schema.Number }, success: Schema.String })

/** The durable wait the run parks at. */
const Settlement = DurableDeferred.make("ledger/settlement", { success: Schema.String })

const Ledger = Flow.make("ledger/Ledger", {
  payload: { amount: Schema.Number },
  success: Schema.String,
  body: (payload) => Credit.call(payload).pipe(Plan.Node.bindPlanned((balance) => Post.call({ balance })))
})
```

## Compose time travel onto the engine

`TimeTravel.layer` asks only for injectable contracts, so it merges onto the
durable host over the same SQLite file. The host provides the journal, the run
store, and the step cache; this program adds the store and a `Jj` service.
Building the layer also finishes or rolls back any rewind a crash interrupted,
which is why recovery never appears as a call:

```ts
import { Interpreter, Jj, TimeTravel } from "@smthrs/flows"
import { NodeRuntime } from "@smthrs/platform-node"
import { SqlTimeTravelStore } from "@smthrs/time-travel"
import * as Layer from "effect/Layer"
import { resolve } from "node:path"

const steps = Interpreter.layer(Ledger).pipe(
  Layer.provideMerge(Credit.toLayer(({ amount }) => Effect.succeed(amount))),
  Layer.provideMerge(Post.toLayer(({ balance }) =>
    Effect.gen(function*() {
      const settlement = yield* DurableDeferred.await(Settlement)
      return `${balance}:${settlement}`
    })
  )),
  Layer.provideMerge(Action.layerImplementations)
)

const workspaceRoot = resolve("workspace")
const host = NodeRuntime.layerHost(
  { filename: `${workspaceRoot}/.flows/engine.db`, workspaceRoot, owner: { hostId: "quickstart" } },
  steps
)

/** `Jj.layerNoop` refuses every call. Replay never calls it; fork and rewind can. */
const layer = TimeTravel.layer.pipe(
  Layer.provideMerge(SqlTimeTravelStore.layer),
  Layer.provideMerge(Jj.layerNoop({})),
  Layer.provideMerge(host)
)
```

`layerHost` applies the engine's migrations when it starts, and
`SqlTimeTravelStore.layer` applies its own ladder on the same database while it
is built. Over a database the engine has not migrated, missing prerequisite
tables fail with a typed `TimeTravelError`; [Provide a store](./guides/provide-a-store.md)
covers `Migrations.run` for that case.

## Start the run, then replay it

A frame is the pair `(lineageId, seq)`. The sequence comes from the journal;
the lineage comes from `FlowEngine.Lineage`, the one constructor that mints
one. The engine stamps its result on every record the run writes, so an
ordinary run is addressable as it stands:

```ts
import { Engine, Journal, RunStore } from "@smthrs/flows"

const main = Effect.gen(function*() {
  // Start a run, then wait until it parks at the settlement.
  const runId = yield* Ledger.start({ amount: 30 })
  const runs = yield* RunStore.RunStore.RunStore
  while ((yield* runs.get(runId)).status !== "suspended") yield* Effect.sleep("50 millis")

  const journal = yield* Journal.Journal.Journal
  yield* journal.flush
  const page = yield* journal.entries({ runId: Journal.JournalEvent.RunId.make(runId), limit: 200 })
  // The frame to read at: the last sequence this run committed.
  const seq = page.entries.at(-1)?.seq ?? 0

  const timeTravel = yield* TimeTravel
  const attempts = yield* timeTravel.inspect(
    { runId, frame: { lineageId: Engine.FlowEngine.Lineage.root(runId), seq } },
    {
      initial: 0,
      reduce: (count: number, entry) => entry.eventType === "flows.engine.attempt-started" ? count + 1 : count
    }
  )
  return { entries: page.entries.length, frame: seq, attempts }
})

console.log(await Effect.runPromise(main.pipe(Effect.provide(layer), Effect.scoped)))
```

Run it:

```bash
node quickstart.ts
```

```text
{ entries: 15, frame: 14, attempts: 2 }
```

The run wrote fifteen journal entries, the frame addresses the last of them,
and folding the prefix under that frame finds the two attempts the engine had
admitted there: `Credit`, and `Post` parked at the settlement. The counts follow
from what the engine recorded, not from anything the projection stores. Run it
again and it prints the same line: `start` mints a new run each time, and each
one parks in the same place.

## What just happened

`inspect` read committed evidence and nothing else. It paged the run's journal
in sequence order, kept the entries whose `meta.lineageId` matches the frame,
stopped at the frame, and handed each one to your `reduce`. There is no
dispatcher behind it, so a replay can never re-execute a model call or a child
flow, and no amount of replaying changes the run.

The `Position` you built is the same value the other two verbs take.
`timeTravel.fork(position)` branches a child run that inherits the history
under it. `timeTravel.rewind(position)` removes everything above it. Rewind
takes only a paused run; a finished one is forked instead.
[Rewind a run to a frame](./guides/rewind-a-run.md) runs both against a real
`jj`.

## Next steps

- [Rewind a run to a frame](./guides/rewind-a-run.md): rewind a paused run and
  watch the rewound step run again, then fork the finished run.
- [Replay a run into a view](./guides/replay-a-run.md): the read knobs, lineage
  filtering, and what a projection may and may not do.
- [Fork a run at a frame](./guides/fork-a-run.md): the child run, its workspace,
  and what it inherits.
- [Frames and lineage](./concepts/frames-and-lineage.md): why a frame carries a
  lineage rather than a run.
