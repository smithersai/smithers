# @smthrs/platform-cloudflare

Release candidate scope, host requirements and compatibility review are defined in the [library support policy](https://github.com/smithersai/smithers/blob/main/RELEASE_SUPPORT.md).

This package declares `effect` as an exact `4.0.5` peer dependency. Install one
`effect` release at that version so all Smithers packages share one Effect
runtime.

**Documentation:** https://github.com/smithersai/smithers/tree/main/packages/smithers/flows/platform-cloudflare/docs

Runs Smithers' durable flow engine on Cloudflare. One Durable Object drives one
flow execution: it stores what to run, wakes itself with its alarm, and builds
the same durable runtime the Node and Bun hosts use, over Postgres through
Hyperdrive. A child flow and the next round of a handoff run on objects of
their own, which the drive that created them starts; a settled child wakes its
parent's object. Leases, attempts, timers and retries stay in the engine's
Postgres store, so a run survives an evicted isolate, a reset object and a
deploy.

## Install

```bash
npm install @smthrs/platform-cloudflare@next @smthrs/flow@next @smthrs/database@next @effect/sql-pg@4.0.5 effect@4.0.5
```

[Installation](docs/installation.md) covers the Worker's compatibility flags and
the database the engine needs.

## Example

An Alchemy Effect-native Durable Object hands its storage to `ExecutionObject`.
`start` records the execution and wakes the object; `wake` makes it drive
again; `alarm` drives it and hands the executions it left for other objects to
them through the class's own namespace:

```ts
import * as Pg from "@effect/sql-pg"
import { PostgresDatabase } from "@smthrs/database"
import { CloudflareRuntime, ExecutionObject } from "@smthrs/platform-cloudflare"
import type { RuntimeContext } from "alchemy"
import * as Cloudflare from "alchemy/Cloudflare"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Redacted from "effect/Redacted"
import { Answer, AnswerLive, ChatDatabase } from "./Answer.ts"

export interface AnswerExecutionShape {
  readonly start: (
    intent: ExecutionObject.Intent
  ) => Effect.Effect<void, ExecutionObject.IntentConflict, RuntimeContext>
  readonly wake: () => Effect.Effect<boolean, never, RuntimeContext>
  readonly alarm: () => Effect.Effect<void, never, RuntimeContext>
}

export class AnswerExecution extends Cloudflare.DurableObject<AnswerExecution, AnswerExecutionShape>()(
  "AnswerExecution"
) {}

export const AnswerExecutionLive = AnswerExecution.make(
  Effect.gen(function*() {
    const state = yield* Cloudflare.DurableObjectState
    // This class's own namespace: each execution's object, by execution id.
    const executions = (yield* Cloudflare.DurableObject) as Cloudflare.DurableObject<AnswerExecutionShape>
    const hyperdrive = yield* Cloudflare.Hyperdrive.Connect(ChatDatabase)
    const database = Layer.unwrap(
      Effect.map(
        hyperdrive.connectionString,
        (url) => PostgresDatabase.layer({ url: Redacted.value(url), driver: Pg, schema: "smithers_flows" })
      )
    )
    return Effect.succeed({
      start: (intent: ExecutionObject.Intent) => ExecutionObject.start(state.storage, intent, Effect.void),
      wake: () => ExecutionObject.wake(state.storage),
      alarm: () =>
        ExecutionObject.alarm(state.storage, {
          flows: [Answer],
          runtime: (intent) =>
            CloudflareRuntime.layer({ hostId: state.id.toString(), executionId: intent.executionId }, AnswerLive)
              .pipe(Layer.provide(database)),
          router: {
            start: (intent) => executions.getByName(intent.executionId).start(intent),
            wake: (executionId) => Effect.asVoid(executions.getByName(executionId).wake())
          }
        }).pipe(Effect.asVoid)
    })
  })
)
```

The Worker resolves the namespace when it initializes. Its request handler names
the object by the execution id, calls `start`, and answers without waiting for
the flow:

```ts
Effect.gen(function*() {
  const executions = yield* AnswerExecution
  return {
    fetch: Effect.gen(function*() {
      const { executionId, payload } = yield* readRequest
      const intent = yield* ExecutionObject.intent(Answer, { executionId, payload })
      yield* executions.getByName(executionId).start(intent)
      return HttpServerResponse.empty({ status: 202 })
    })
  }
})
```

[Host a flow in a Durable Object](docs/guides/host-a-flow-in-a-durable-object.md)
walks the whole wiring, binding and database included.

## How an execution runs

```
start ──► store intent, alarm at now+5 s ──► caller's write ──► alarm at now
                                                                   │
alarm ◄────────────────────────────────────────────────────────────┘
  │ count the attempt, arm the alarm one backoff away (the watchdog)
  │ build the runtime in this alarm, drive the flow once (EngineStore.drive),
  │   starting no new step after the drive budget (600 s)
  │ route: start each new child or next round on its own object,
  │        wake each parent or child the drive made due (router)
  ├─ settled ──► record when, alarm at the end of the retention window, clear the count
  ├─ parked  ──► alarm at the engine's next wake, read it again, clear the count
  ├─ yielded ──► the budget ran out at a step boundary: alarm at now, clear the count
  └─ failed  ──► keep the count, alarm one backoff away

final alarm, one day after the settlement (settledRetentionMs)
  └─ forgotten ─► delete the intent, the count and the settlement; arm nothing
```

```
parent object                 child object
  alarm: drive ─ parks on the child
         route ─ start(child) ──► start: store intent, alarm at now
                                  alarm: drive ─ settles
                                         route ─ wake(parent)
  alarm ◄──────────────────────────────────────────┘
         drive ─ reads the child's result, settles
```

The backoff is one second, doubling, at most five minutes, and never gives up.
An alarm that dies in the middle of a drive leaves its attempt counted and its
successor armed, so the next incarnation of the object takes the run over one
backoff later. It takes it at once even though the dead incarnation's lease is
still fresh: an owner under the same object's host id with another incarnation
number is an earlier incarnation, and Cloudflare runs one alarm handler at a
time. [The execution lifecycle](docs/concepts/execution-lifecycle.md) states
each guarantee and what proves it.

## Modules

| Module              | What it provides                                                                                                                                                                          |
| ------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `CloudflareHost`    | `layer`: the closed Host surface on Cloudflare, with `@smthrs/crypto`'s `WebCrypto.layer` as `effect/Crypto`.                                                                             |
| `CloudflareRuntime` | `layer({ hostId, executionId }, registerFlows)`: the durable engine for one execution over an injected `SqlClient`.                                                                       |
| `ExecutionObject`   | `start`, `wake`, `alarm` and `intent`: the per-execution Durable Object, as functions over a structural slice of Durable Object storage.                                                  |
| `EdgeCache`         | `layer({ name?, maxEntryBytes? })`: `@smthrs/artifacts`' `ImmutableCache` over the Workers Cache API, `caches.default` or a named cache.                                                  |
| `SandboxObject`     | `wake`, `rearm` and `run`: start a container Durable Object's container offline with its outbound HTTP intercepts, re-arm its inactivity timeout, and run a command for its exit code.    |
| `ContainerTerminal` | `ensureSession` and `attach`: a browser terminal over `@smthrs/sandbox`'s `TerminalProtocol`, one tmux session per terminal and one tmux client per WebSocket; readers' input is dropped. |
| `ContainerSession`  | `make(container, { id, workdir, user?, env? })`: the container as `@smthrs/sandbox`'s `Sandbox.Session`, so `SandboxTools` and `Sandbox.layerHost` run on it.                             |

## A terminal in a container

A container Durable Object (a Cloudflare Container with
`schedulingPolicy: "durable_object"`) wakes its box with `SandboxObject.wake`,
creates a terminal's tmux session with `ContainerTerminal.ensureSession`, and
bridges each viewer's accepted WebSocket with `ContainerTerminal.attach`. Both
take the container as a structural slice of an Effect container client, so an
Alchemy object's container handle passes in as is:

```ts
const box = yield * Box // the object's Cloudflare.Container handle
yield * SandboxObject.wake(box, { intercepts: [{ host: "forge.example.internal", fetcher: egress }] })
yield * ContainerTerminal.ensureSession(box, { name: terminalId, user: "1000:2000", cwd: "/workspace", env })

// per socket, after server.accept()
yield *
  state.waitUntil(
    ContainerTerminal.attach(box, server, { name: terminalId, user: "1000:2000", access, cols, rows, env })
  )
```

The owner (`write`) types and resizes; every byte and resize from a `read`
viewer is dropped. A reload attaches a new tmux client to the same shell.
[Attach a terminal to a container](docs/guides/attach-a-terminal-to-a-container.md)
walks the wiring.

## What it does not do

- **No filesystem, processes or jj.** `FileSystem` refuses every call with
  `PermissionDenied`, `ChildProcessSpawner` refuses every spawn with
  `NotFound`, and `Jj` refuses with `not_installed`. A step that declares a file
  boundary fails with `unsupported_boundary`. Run such work on a sandbox host.
- **One execution per object, and every object of one class.** The runtime
  refuses every run but its own; a child or the next round runs on its own
  object, which the router names by execution id. So every object's `flows`
  lists every flow an execution may start as a child or hand off to.
- **Steps run at least once.** A step interrupted by a reset runs again in the
  next incarnation. Make its effects idempotent.
- **Event waits need a wake.** A flow parked on a `DurableDeferred` has no
  timer; whoever completes the deferred must call the object's `wake`. So does
  whoever cancels an execution.

Everything here bundles for workerd: no module imports a `node:` built-in or a
Cloudflare module, and the tests run under Node with in-memory stand-ins for
Durable Object storage, a container and a WebSocket. The terminal's suite also
runs a real container through Miniflare and Docker when Docker is present.
The suite provisions its digest-pinned egress sidecar before startup; workerd
requires that image locally and never pulls it. Startup diagnostics retain
native lifecycle errors and report the failed stage, running state and error
type without command arguments, output or the forge credential.
