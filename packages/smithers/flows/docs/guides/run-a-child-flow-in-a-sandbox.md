---
title: "Run a child flow in a sandbox"
description: "Put a child flow's own code on a provisioned machine with SandboxedFlow: write the entry module, call execute directly, declare the whole execution as one durable action of a parent flow, or reach another machine over SSH with CommandSandbox."
sidebar:
  order: 4
---

`SandboxedFlow`, from `@smthrs/platform-node`, runs a child flow's own code
inside a machine a `Sandbox.Provider` provisions. The child's TypeScript never runs in the parent's
process. Read
[the sandboxed runner protocol](../concepts/runner-protocol.md) for what happens
on the wire; this guide is the wiring.

## Before you start

The programs below run in a project set up as in the [Quickstart](../quickstart.md).
They build a provider from a contained Node host, `NodeHost.layerContained`,
which `@smthrs/flows` depends on but does not re-export. Add
`@smthrs/platform-node` at the version of `@smthrs/flows` you have:

```bash
npm install @smthrs/platform-node@1.0.0-rc.18
```

Every output block below is real output from 1.0.0-rc.6.

## Write the entry module

The entry is the module that gets bundled. It exports the flow, and, when the
flow's body names actions, a `layer` that implements them. Everything the
implementation touches belongs to the guest: `process.cwd()` is the session
workdir, and files it writes land in the workspace the host can read back.
This one reports where it ran:

```ts
// child.ts
import { Action, Flow } from "@smthrs/flows"
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import { writeFile } from "node:fs/promises"
import { hostname } from "node:os"

export const Greeting = Schema.Struct({
  greeting: Schema.String,
  host: Schema.String,
  pid: Schema.Number,
  workdir: Schema.String
})

export const ComposeGreeting = Action.make("app/ComposeGreeting", {
  payload: { name: Schema.String },
  success: Greeting
})

export const Greet = Flow.make("app/Greet", {
  payload: { name: Schema.String },
  success: Greeting,
  body: (payload) => ComposeGreeting.call(payload)
})

/** The implementations the guest runner provides beside the interpreter. */
export const layer = ComposeGreeting.toLayer(({ name }) =>
  Effect.promise(async () => {
    const greeting = `hello, ${name}`
    await writeFile("greeting.txt", greeting)
    return { greeting, host: hostname(), pid: process.pid, workdir: process.cwd() }
  })
)
```

The flow may be exported under any name, including as the default export. The
runner finds it by tag.

## Run it directly

`execute` acquires the session, runs the protocol, and releases the session
when it returns. A normal completion tears the machine down. Create `greet.ts`:

```ts
import { Kernel, Sandbox } from "@smthrs/flows"
import { SandboxedFlow } from "@smthrs/platform-node"
import * as NodeHost from "@smthrs/platform-node/NodeHost"
import * as Effect from "effect/Effect"
import * as FileSystem from "effect/FileSystem"
import * as Layer from "effect/Layer"
import { ChildProcessSpawner } from "effect/process/ChildProcessSpawner"
import { Greet } from "./child.ts"

const greet = Effect.gen(function*() {
  const fs = yield* FileSystem.FileSystem
  const spawner = yield* ChildProcessSpawner
  const provider = Sandbox.DirectorySandbox.make({ fs, spawner, root: "/var/tmp/smithers" })
  const result = yield* SandboxedFlow.execute(Greet, { name: "Ada" }, {
    provider,
    session: "greet-1",
    entry: new URL("./child.ts", import.meta.url)
  })
  // result.output is Greet's success value, decoded through Greet's own schema.
  return result.output
})

/** The contained Node host the provider takes its filesystem and spawner from. */
const host = NodeHost.layerContained().pipe(
  Layer.provide(Kernel.ProcessLedger.layerMemory({ hostId: "greet", ownerPid: process.pid }))
)

console.log(`parent pid ${process.pid}`)
console.log(await Effect.runPromise(greet.pipe(Effect.provide(host), Effect.scoped)))
```

```bash
node greet.ts
```

```text
parent pid 59979
{
  greeting: 'hello, Ada',
  host: 'Williams-MacBook-Pro-3.local',
  pid: 60043,
  workdir: '/private/var/tmp/smithers/greet-1-0db7275a3d6f407c'
}
```

The child ran in its own process, in a scratch directory the provider made.

`entry` is a `file:` URL or an absolute path. `provider` is a
`Sandbox.Provider` value that you pass in: there is no string registry, no
lookup by name, and no environment variable default.
[Choose a provider](#choose-a-provider) covers the choices.

The remaining options are all optional:

| Option        | Default                       | What it does                                                                                                                                                                    |
| ------------- | ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `runtime`     | `"node"`                      | The guest executable: `"node"`, `"bun"`, or an executable path. Each path is quoted as one shell word. Use a wrapper script for flags.                                          |
| `captureWork` | `false`                       | Capture the workdir's changes as a `Sandbox.Work` git patch. The workdir must be a git repository. See [Capture the work a sandboxed child did](./collect-a-workspace-diff.md). |
| `limits`      | `SandboxedFlow.defaultLimits` | Bounds on the result and the patch.                                                                                                                                             |
| `timeout`     | 10 minutes                    | The wall-clock budget for the whole session, acquisition through result readback. It is measured on the platform timer, so it fires under a frozen test clock too.              |

## Make it one durable action of a parent

This is the usual shape. `action(flow)` declares an ordinary durable action over
the child's payload schema, and `toLayer` implements it with `execute`. The
parent's body calls it like any other action. Create `parent.ts`:

```ts
import { Action, Flow, Interpreter, Kernel, Sandbox } from "@smthrs/flows"
import { NodeRuntime, SandboxedFlow } from "@smthrs/platform-node"
import * as NodeHost from "@smthrs/platform-node/NodeHost"
import * as Effect from "effect/Effect"
import * as FileSystem from "effect/FileSystem"
import * as Layer from "effect/Layer"
import { ChildProcessSpawner } from "effect/process/ChildProcessSpawner"
import * as Schema from "effect/Schema"
import { resolve } from "node:path"
import { Greet, Greeting } from "./child.ts"

const RunGreet = SandboxedFlow.action(Greet)

const SandboxedGreeting = Flow.make("app/SandboxedGreeting", {
  payload: { name: Schema.String },
  success: SandboxedFlow.resultSchema(Greeting),
  error: SandboxedFlow.ExecuteError,
  body: (payload) => RunGreet.call(payload)
})

const program = Effect.gen(function*() {
  const fs = yield* FileSystem.FileSystem
  const spawner = yield* ChildProcessSpawner
  const provider = Sandbox.DirectorySandbox.make({ fs, spawner, root: "/var/tmp/smithers" })

  const stack = Layer.mergeAll(
    SandboxedFlow.toLayer(RunGreet, Greet, ({ executionId, callId }) => ({
      provider,
      session: `greet:${executionId}:${callId}`,
      entry: new URL("./child.ts", import.meta.url)
    })),
    Interpreter.layer(SandboxedGreeting)
  ).pipe(Layer.provideMerge(Action.layerImplementations))

  const workspaceRoot = resolve("workspace")
  const host = NodeRuntime.layerHost(
    { filename: `${workspaceRoot}/.flows/engine.db`, workspaceRoot, owner: { hostId: "parent" } },
    stack
  )
  const result = yield* SandboxedGreeting.execute({ name: "Ada" }, { executionId: "greeting-1" }).pipe(
    Effect.provide(host)
  )
  return result.output
})

const contained = NodeHost.layerContained().pipe(
  Layer.provide(Kernel.ProcessLedger.layerMemory({ hostId: "parent", ownerPid: process.pid }))
)

console.log(await Effect.runPromise(program.pipe(Effect.provide(contained), Effect.scoped)))
```

Run it twice:

```bash
node parent.ts
node parent.ts
```

```text
{
  greeting: 'hello, Ada',
  host: 'Williams-MacBook-Pro-3.local',
  pid: 60264,
  workdir: '/private/var/tmp/smithers/greet-greeting-1-key1_de667bae3319aaa339-7741fe3821b5b87a'
}
{
  greeting: 'hello, Ada',
  host: 'Williams-MacBook-Pro-3.local',
  pid: 60264,
  workdir: '/private/var/tmp/smithers/greet-greeting-1-key1_de667bae3319aaa339-7741fe3821b5b87a'
}
```

The second run prints the first run's `pid`: `greeting-1` had finished, so the
engine answered it from the journal.

The action's tag is `app/Greet/sandboxed` unless you pass
`{ name: "..." }` as `action`'s second argument. Both forms preserve the literal
name in the type, so each declaration requires its own implementation. Its success schema is
`resultSchema(Greeting)`, which is `{ output, work, capabilityCeiling }`, and
its error schema is `ExecuteError`: `SandboxedFlowError` or the kernel's
`PermissionDenied`.

Compose the returned layer beside `Interpreter.layer(parent)` over one
`Action.layerImplementations`, exactly as you would any other action
implementation.

## Derive the session key from the execution and call

`toLayer`'s third argument is either the placement itself or a function of the
call's context: the decoded payload, the parent's `executionId`, and `callId`.
Derive the session key from both `executionId` and `callId`, as above. The engine
assigns a distinct `callId` to each call, including parallel calls with identical
payloads, and preserves it across retries and resume. A crash that left a machine
behind is reattached by the resumed call with the same key. The parent id or
payload alone cannot distinguish repeated calls.

Because the whole sandboxed execution is one durable action, a second run of the
parent over the same database answers from the journal and never asks the
provider for a machine at all.

## Choose a provider

Providers come from [`@smthrs/sandbox`](../../sandbox/docs/api.md), which the barrel
re-exports as the `Sandbox` namespace. It ships several, and
`DirectorySandbox`, used above, is the one to start with: its machines are
scratch directories on this host, so the whole placement path runs with no
container runtime. It takes the filesystem and the spawner as values, which the
programs above read from `NodeHost.layerContained()` over a `ProcessLedger`.
The memory ledger contains this process's commands; the
[sandbox quickstart](../../sandbox/docs/quickstart.md) covers the durable one.
A raw or deadline-only spawner is refused before the directory is created.

A directory is a workspace boundary, not a security boundary: nothing confines
the guest process to it. Swap in `Sandbox.ContainerSandbox` or a vendor
provider where isolation matters.

Any value with an `acquire` method satisfies the provider contract, which
through the barrel is `Sandbox.Sandbox.Provider`: the package's own `Sandbox`
module sits one level below its namespace. Wrapping a provider to count
acquisitions or inject a fault is a few lines:

```ts
import type { Sandbox } from "@smthrs/flows"

let acquisitions = 0
const counted = (underlying: Sandbox.Sandbox.Provider): Sandbox.Sandbox.Provider => ({
  acquire: (session) => {
    acquisitions++
    return underlying.acquire(session)
  }
})
```

## Run the child on another machine

`Sandbox.CommandSandbox` reaches its machine through an argv prefix: each
command the session runs is the prefix followed by the guest's command. `[]` is
this machine. `["ssh", "you@build-host"]` is another one: the bundle, the
request, and the result cross the SSH channel as base64 text, and the child
runs there under the `runtime` you name. Create `remote.ts`:

```ts
import { Kernel, Sandbox } from "@smthrs/flows"
import { SandboxedFlow } from "@smthrs/platform-node"
import * as NodeHost from "@smthrs/platform-node/NodeHost"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import { ChildProcessSpawner } from "effect/process/ChildProcessSpawner"
import { Greet } from "./child.ts"

// node remote.ts <ssh destination> [path to node on that machine]
const [destination = "localhost", runtime = "node"] = process.argv.slice(2)

const greet = Effect.gen(function*() {
  const spawner = yield* ChildProcessSpawner
  const provider = Sandbox.CommandSandbox.make({
    spawner,
    prefix: ["ssh", "-o", "BatchMode=yes", destination],
    workdir: "/tmp/smithers-greet"
  })
  const result = yield* SandboxedFlow.execute(Greet, { name: "Ada" }, {
    provider,
    session: "greet-ssh-1",
    entry: new URL("./child.ts", import.meta.url),
    runtime
  })
  return result.output
})

const host = NodeHost.layerContained().pipe(
  Layer.provide(Kernel.ProcessLedger.layerMemory({ hostId: "greet", ownerPid: process.pid }))
)

console.log(await Effect.runPromise(greet.pipe(Effect.provide(host), Effect.scoped)))
```

The machine needs Node.js 22.19.0 or later and key-based SSH login;
`BatchMode=yes` makes a password prompt fail instead of hang. When `node` is not
on the `PATH` a non-interactive SSH command sees, pass its absolute path:

```bash
node remote.ts you@build-host /home/you/.local/node-v26.10.0-linux-x64/bin/node
```

```text
{
  greeting: 'hello, Ada',
  host: 'msb-lat-nyc-01',
  pid: 1988990,
  workdir: '/tmp/smithers-greet'
}
```

The child ran on a Linux x86_64 host, in `/tmp/smithers-greet`, and left
`greeting.txt` there. This SSH run was checked by hand against 1.0.0-rc.6. The
docs' own tests do not reach another machine, so they do not cover it.

What the prefix controls:

- **Quoting.** With `ssh` as the prefix's program, the provider quotes each
  guest argument and joins them into one command line, because the remote shell
  parses it again. Set `joinsArguments: true` for any other prefix whose far end
  does the same.
- **Credentials.** `prefix` may be an `Effect` instead of an array. The provider
  asks it again for every command, so a credential that expires stays fresh.
  Failures never quote the prefix, which may hold one.
- **Lifecycle.** The provider owns no machine. `acquire` prepares `workdir`, and
  closing the session ends its commands and leaves the machine running. Every
  session of one provider runs in that `workdir`, so give work that runs at the
  same time its own provider and directory.
- **Liveness.** Each command runs beside a heartbeat that reads the machine's
  boot id, so a machine that stops answering or restarts ends the command with
  `unavailable` instead of leaving it waiting.

## Check the guest image

The runtime the bundle is started with has to be on the guest's `PATH`, and
nothing installs it. `node:22-alpine` has `node`; bare `alpine` does not, and a
missing runtime comes back as `guest_failed` naming what it looked for. The full
list of refusals is in [Troubleshooting](../troubleshooting.md).

## Failure diagnostics

`result_unreadable` means a zero-exit guest left no result, wrote malformed
protocol JSON, or returned a result for another attempt. Each execution creates
a fresh `attempt` nonce in `request.json`; the guest echoes it in both success
and failure envelopes. The host accepts only the current nonce and removes any
leftover `result.json` before launch. Reattaching a session preserves workspace
files but cannot reuse a previous attempt's result.

Before writing a failed `result.json`, the guest applies the engine logger's
shared credential key and text rules to error fields, messages, and string
failures. The host applies the same rules to `SandboxedFlowError.message` and
its provider causes, and redacts guest stdout/stderr before taking diagnostic
tails. Sensitive fields such as `password` and nested `Authorization` become
placeholders. Error details that do not match the rules remain available.

These rules are best effort, not a guarantee for arbitrary secret text. They
cover failure diagnostics, not successful output, request payloads, collected
files, or the guest's original output streams. Keep secrets out of those
surfaces or model them with `Schema.Redacted` where supported.
