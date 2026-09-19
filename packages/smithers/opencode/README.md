# @smthrs/opencode

This package declares `effect`, `@effect/platform-node`, and `@effect/sql-sqlite-node` as exact `4.0.0-rc.115` peers. Keep the application on that version so all Smithers packages share one Effect runtime.

Release candidate scope, host requirements and compatibility review are defined in the [library support policy](https://github.com/smithersai/smithers/blob/main/RELEASE_SUPPORT.md).

An OpenCode protocol v1 server over the Smithers agent loop. It serves one directory on one socket, and the hosted OpenCode app at `https://app.opencode.ai` connects to it the way it connects to `opencode serve`: sessions, prompts, the timeline of tool cards, permission cards, history after a reload, and the event stream. The turn behind each prompt is a Smithers cell loop turn, and the server folds the loop's harness events into the OpenCode events the app renders.

`smithers opencode`, from [`@smthrs/cli`](https://cli.smithers.sh), is the host over this package: it resolves the directory, picks the driver, and binds the socket. Install the CLI when you want the server without writing code; install this package when you are embedding the surface or writing a driver.

## Install

```sh
pnpm add @smthrs/opencode@1.0.0-rc.0 effect@4.0.0-rc.115 @effect/platform-node@4.0.0-rc.115 @effect/sql-sqlite-node@4.0.0-rc.115
```

Node 22.19.0 or later is required.

## Modules

| Module           | What it holds                                                                                                                                                              |
| ---------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Serve`          | The bind and its admission rule, the banner, `app` (the whole application as a router layer) and `layer` (the same on a Node socket with its own SQLite store).            |
| `Routes`         | Every v1 route the hosted app and the shipped TUI call, with the 1.18.31 response shapes, plus the three v2 routes the app calls in v1 mode.                               |
| `Events`         | The server-sent event hub: `server.connected`, live events in the `{directory, project, payload}` envelope, heartbeats, and a bounded replay for reconnects.               |
| `Store`          | Sessions, message headers, parts, pending permissions, grants, and open turns in `<directory>/.smithers/opencode.sqlite`, so history is a read.                            |
| `Projection`     | The pure fold from harness `AgentEvent`s to OpenCode v1 events and parts, with part ids derived from the message and a sort key so a replayed frame updates cards.         |
| `Health`         | The health color: the `harness/health` classifier, the color rule as a pure function, the title dot, the evaluator over `AI_GATEWAY_API_KEY`, and the record per decision. |
| `Turns`          | One turn per prompt: opens the projection, forks the driver, stores then publishes every event, answers permissions, aborts, re-opens what a restart finds.                |
| `Driver`         | The seam a turn runner implements: `start`, `interrupt`, `permission`, `steer`, `resumeOnBoot`.                                                                            |
| `EngineDriver`   | The driver over the durable flow engine: one `Agent.run` per prompt under `<directory>/.smithers/opencode.sqlite`, permission parks, steering, interrupts, resume.         |
| `ScriptedDriver` | A driver that replays a recorded turn, with permission parks and their continuations.                                                                                      |
| `DemoScript`     | The recorded turn the scripted driver ships with: a read, a list, a read-only demand, a shell call behind a permission, and a final answer.                                |
| `Pricing`        | The published list prices of the starter seats, so the header's cost is a number.                                                                                          |
| `Ids`            | OpenCode identifiers: prefixes, the time-ordered head, and derived part ids.                                                                                               |
| `Cors`           | The allowed origins and the preflight answer.                                                                                                                              |
| `Auth`           | Basic authentication from `OPENCODE_SERVER_PASSWORD`, with the health probes left open.                                                                                    |
| `Protocol`       | The wire types, transcribed from the OpenAPI document.                                                                                                                     |

## Hosting the server

The server needs a driver and a store. The engine driver brings its own
store over the engine database; the scripted driver is paired with one.

```ts
import * as EngineDriver from "@smthrs/opencode/EngineDriver"
import * as Serve from "@smthrs/opencode/Serve"
import { Effect } from "effect"

const directory = process.cwd()
const seat = "cerebras:gpt-oss-120b"
const maxFrames = 100
const program = Serve.host({ directory, bind: Serve.defaultBind, version: "1.0.0-rc.0", seat, maxFrames }).pipe(
  Effect.provide(EngineDriver.layer({ directory, seat, maxFrames, host }))
)
```

The frame budget goes to both: the engine enforces it, and the projection
reports it to health until the engine's own `discipline-armed` event says
what was armed.

`host` is an `EngineDriver.Host`: the platform a flow body reaches the
world through, a seat resolver, and a flow registry. `smithers opencode`
builds it from `NodeControl`; a test builds it from the Node platform and a
scripted seat.

```ts
import * as DemoScript from "@smthrs/opencode/DemoScript"
import * as ScriptedDriver from "@smthrs/opencode/ScriptedDriver"
import * as Serve from "@smthrs/opencode/Serve"
import * as Store from "@smthrs/opencode/Store"
import { Effect, Layer } from "effect"

const scripted = Serve.host({
  directory: process.cwd(),
  bind: Serve.defaultBind,
  version: "1.0.0-rc.0",
  seat: "scripted:demo"
}).pipe(
  Effect.provide(
    Layer.mergeAll(
      ScriptedDriver.layer({ script: DemoScript.script }),
      Store.layerSqlite(Serve.databasePath(process.cwd()))
    )
  )
)
```

`AI_GATEWAY_API_KEY` is required to run a model. The harness asks Jev whether a completion describes what the run did and fails a run it cannot judge, so `smithers opencode` refuses to start when the host can bind no evaluator (`EngineDriver.evaluatorRefusal`, exit 2). The same key turns on the cell's `classify` flows and the health dot (🟢 🟡 🔴, ⚪ when one evaluation does not answer). `--scripted` replays the recorded turn, runs no model, and needs no key.

The contract this server answers is recorded in `docs/jev-harness/trace/summary.md` in the repository: the routes per step, the events per step, and the envelope, traced from the hosted app against OpenCode 1.18.31.

The shipped OpenCode TUI is the second client: `opencode attach http://127.0.0.1:4096 --dir <the directory>` connects, lists the sessions, streams a turn, renders the cards and answers a permission. What it asks for beyond the hosted app is recorded in `test/TuiContract.test.ts`, and what it offers that this server does not answer is in `docs/jev-harness/runbook.md`.
