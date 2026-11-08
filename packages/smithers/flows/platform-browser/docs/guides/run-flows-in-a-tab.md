---
title: "Run durable flows in a browser tab"
description: "Host the durable flow engine in a dedicated worker over SQLite in OPFS, start runs from any tab, and survive a closed tab or a killed browser."
---

This guide runs a `@smthrs/flow` flow durably in the browser. Its step record
lives in SQLite in the origin private file system (OPFS), so a run that a
closed tab or a crashed browser interrupts resumes at the step it was in when
the app opens again. A step whose result was recorded never runs again.

You write three modules:

| Module             | Runs in                              | Calls                                   |
| ------------------ | ------------------------------------ | --------------------------------------- |
| `flows.ts`         | both                                 | `Flow.make`, `Action.make`              |
| `engine.worker.ts` | the dedicated worker each tab starts | `BrowserRuntime.run`                    |
| your tab code      | every tab                            | `BrowserEngine.layer`, then the service |

## Declare the flows

Declare each flow once, and the layer that registers its actions'
implementations. The worker registers them; every tab imports the same
declarations to encode payloads and decode results.

```ts
// flows.ts
import { Action, Flow, Interpreter } from "@smthrs/flow"
import { Node } from "@smthrs/plan"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Schema from "effect/Schema"

export const Record = Action.make("app/Record", {
  payload: { label: Schema.String },
  success: Schema.String
})

export const Answer = Flow.make("app/Answer", {
  payload: { question: Schema.String },
  success: Schema.String,
  body: Node.capture(
    {},
    ({ question }) => Record.call({ label: `asked:${question}` }).pipe(Node.andThen(Record.call({ label: "answered" })))
  )
})

export const registration = Layer.mergeAll(
  Record.toLayer(({ label }) => Effect.succeed(label)),
  Interpreter.layer(Answer, { callbackIdentity: "stable" })
).pipe(Layer.provideMerge(Action.layerImplementations))
```

## Write the engine worker

The worker hands `BrowserRuntime.run` the synchronous wa-sqlite build as two
lazy imports: its JavaScript and its wasm bytes. `run` calls them only once
this worker leads, and never fetches anything itself, so a worker that waits
its turn loads neither, and the build reaches only the worker's bundle. How
you get the wasm's URL is your bundler's business; with Vite it is a `?url`
import.

```ts
// engine.worker.ts
import wasmUrl from "@journeyapps/wa-sqlite/dist/wa-sqlite.wasm?url"
import { BrowserRuntime } from "@smthrs/platform-browser"
import { Answer, registration } from "./flows.ts"

BrowserRuntime.run({
  name: "smithers",
  sqlite: {
    module: () => import("@journeyapps/wa-sqlite/dist/wa-sqlite.mjs"),
    wasm: () => fetch(wasmUrl).then((response) => response.arrayBuffer())
  },
  flows: [Answer],
  registerFlows: registration
})
```

`name` names the engine: its host id in the store, its Web Lock, its
`BroadcastChannel`, and its OPFS directory `smithers/<name>`. Every tab of one
app passes the same name. `flows` lists every flow a tab may start; a request
for any other flow is refused.

## Start runs from a tab

`BrowserEngine.layer` starts this tab's worker, asks the browser for
persistent storage, and gives the tab a `BrowserEngine`. Build it when the tab
opens, not on the first request: the worker has to exist to take over when the
leader's tab closes.

```ts
import { BrowserEngine } from "@smthrs/platform-browser"
import * as Effect from "effect/Effect"
import * as ManagedRuntime from "effect/ManagedRuntime"
import { Answer } from "./flows.ts"

const runtime = ManagedRuntime.make(BrowserEngine.layer({
  name: "smithers",
  worker: () => new Worker(new URL("./engine.worker.ts", import.meta.url), { type: "module" })
}))
await runtime.runPromise(BrowserEngine.BrowserEngine)

const exit = await runtime.runPromise(Effect.gen(function*() {
  const engine = yield* BrowserEngine.BrowserEngine
  yield* engine.start(Answer, { executionId: "answer-1", payload: { question: "why" } })
  return yield* engine.result(Answer, "answer-1")
}))
```

`start` returns once the leader recorded the run, and the run continues in the
background. Pick the execution id yourself and keep it: it is how any tab
asks about the run later, and starting the same id again is a no-op.

| Call                                     | What it does                                                                                  |
| ---------------------------------------- | --------------------------------------------------------------------------------------------- |
| `start(flow, { executionId, payload })`  | Admits the run and returns; the payload is encoded with the flow's own schema.                |
| `result(flow, executionId)`              | Waits for the run to settle and returns its `Exit`; a cancelled run ends interrupted.         |
| `cancel(flow, executionId)`              | Requests cancellation, which runs the flow's normal cleanup.                                  |
| `signal(flow, executionId, name, value)` | Resolves the run's `WaitFor` point `name` with a JSON value.                                  |
| `events`                                 | Streams the execution id and event type of every event the engine commits.                    |
| `inspect(runId, { afterSeq?, limit? })`  | Reads one run: lifecycle, steps, child runs and a journal page; values redacted, 16 KiB each. |
| `list({ limit?, cursor?, roots? })`      | Pages the engine's runs, newest first; parentless runs unless `roots` is `false`.             |

A request the leader refuses fails with `RequestRefused`, whose `error` is the
tag of what failed, never its message.

Each call reads only the flow's tag and schemas (`BrowserEngine.FlowReference`).
Pass the flow, or, when its steps import something the tab must not load, a
plain object with the flow's `_tag`, `payloadSchema`, `successSchema` and
`errorSchema`. Declare the flow from those same schemas, and import the whole
flow only in the engine worker.

## What survives what

| What happens                                   | What the engine does                                                                             |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| The leader's tab closes while another is open  | The next tab's worker takes the lock, resumes the run at the step it was in, and finishes it.    |
| Every tab closes, or the browser is killed     | The run waits. The first tab to open resumes it.                                                 |
| A durable sleep comes due while no tab is open | It fires when the first tab opens.                                                               |
| A request is in flight when the leader dies    | The tab sends it again to the next leader. Every request is idempotent.                          |
| A step was running when its worker died        | It runs again. A step whose result was recorded never does, so make external effects idempotent. |

## Next steps

- [The durable browser engine](../concepts/durable-browser-engine.md): leader
  election, the wake on load, and why the engine runs in a dedicated worker.
- [Testing](../testing.md#test-the-durable-engine): run the engine under Node
  with injected services.
- [API reference](../api.md#the-durable-engine): every export.

A failed SQL statement still updates transaction ownership. If it leaves a
transaction open, closing the tab rolls it back; if SQLite rolls it back, the
next statement starts outside it. A transaction containing failed SQL is refused
rather than replayed after its leader ends.

OPFS handles held by a previous worker are acquired with Effect's host resource
retry schedule until released or cancelled. Other open failures remain errors.
After a worker failure, a new leader announcement lets its tab send requests again.

### Cold storage writes

The exclusive OPFS pool coalesces adjacent WAL writes into at most 64 KiB per
open WAL file. SQLite writes a frame's header and page separately; forwarding
each fragment to a synchronous access handle makes startup pay a host round
trip for every fragment. Reads, size checks, truncation, file close and sync
drain pending bytes first. The database format, `synchronous = FULL` and every
SQLite sync call stay intact. A failed host write fails subsequent operations
on that file until it closes.

`BrowserSqlite.open` reads back `PRAGMA synchronous` before lending a connection
and refuses any mode other than `FULL` (2), including on a nonexclusive VFS.
A refused configuration reports the existing journal-stage diagnostic and the
scope releases the connection.

Pool disposal drops an unsynced buffered tail. Every acknowledged `FULL`
commit has already drained and flushed its bytes; SQLite's normal file close
also drains before releasing the file.

`test/browser/WalWrites.test.ts` counts real OPFS writes for a fixed 128-row
transaction and kills the worker at its commit acknowledgment, before any next
SQL call or close can drain the buffer. Reopening checks every value and SQLite
integrity; a second worker crash checks uncommitted writes. Removing the `jSync`
drain loses acknowledged rows and fails this test. Its operation-count gate
does not depend on a fast machine. `test/WalBuffer.test.ts` exercises bounded
buffers, reused byte views, file visibility and injected host failures over
real files; the existing browser durability suite covers engine recovery.
