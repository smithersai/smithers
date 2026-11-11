---
title: "Quickstart"
description: "Run a file operation and a command through BunHost.layer, then turn containment on and watch a spawned child enter and leave the process ledger."
sidebar:
  order: 2
---

This quickstart runs one program against the Bun host twice: first on the plain
bundle, then with process containment turned on. By the end you will have
executed a real child process through the host surface and seen its record
appear in, and disappear from, the process ledger. Each step
below is TypeScript; the [VibeLang tab](#the-same-walkthrough-in-vibelang) runs
both programs as Effect code.

## Prerequisites

- Bun 1.4.0 or later, or Node.js 22.19.0 or later.
- A project with the packages installed:
  `bun add @smthrs/platform-bun@1.0.0-rc.17 effect @smthrs/kernel@1.0.0-rc.17`.
  That also installs the required peer `@smthrs/platform-node`, which ships the
  `smithers-jj-export` helper the filesystem slot runs. `@smthrs/kernel` is on
  the line because `contained.ts` imports its `ProcessLedger`, and Bun's
  isolated linker and pnpm link only the packages a project declares. See
  [Installation](./installation.md).
- [Jujutsu](https://jj-vcs.github.io) at jj 0.39.0 or later on `PATH`, only for
  a program that calls `Jj`. Neither program below does, and every bundle
  builds without jj; a `Jj` operation on a host without it fails with
  `JjError` `not_installed`. See [Installation](./installation.md) for
  `SMITHERS_JJ_PATH`.

## Run a file operation and a command

Create `quickstart.ts`. The program asks for two of the five host services by
tag, and names Bun nowhere:

```ts
import { BunHost } from "@smthrs/platform-bun"
import * as Effect from "effect/Effect"
import * as FileSystem from "effect/FileSystem"
import * as ChildProcess from "effect/process/ChildProcess"
import { ChildProcessSpawner } from "effect/process/ChildProcessSpawner"

const program = Effect.gen(function*() {
  const fs = yield* FileSystem.FileSystem
  const spawner = yield* ChildProcessSpawner

  yield* fs.writeFileString("report.txt", "written through the host filesystem\n")
  const readBack = yield* fs.readFileString("report.txt")
  const listed = yield* spawner.string(ChildProcess.make("ls", ["report.txt"]))

  return { listed: listed.trim(), readBack: readBack.trim() }
})

Effect.runPromise(Effect.provide(program, BunHost.layer)).then(console.log)
```

Run it:

```bash
bun run quickstart.ts
```

```text
{
  listed: "report.txt",
  readBack: "written through the host filesystem",
}
```

`BunHost.layer` provided all five slots; the program used two of them. The
other three were built and never asked for. Building `Jj` spawned nothing: its
jj version probe runs on the first `Jj` operation, which this program never
makes.

## Turn containment on

The plain bundle signals its target when the scope closes. A target that exits
first can leave background descendants holding output open, and a crashed
host cannot run that finalizer.

`BunHost.layerContained` prepares a supervisor for each command, records its
identity before target execution, and keeps a `SIGTERM`-then-`SIGKILL` deadline
for the owned process group even after the target exits. The supervisor's
private host connection also initiates cleanup on host loss. The required
`ProcessLedger` lets a later host reconcile cleanup that was not confirmed;
the memory ledger below deliberately has no persistence across restarts.

Create `contained.ts`:

```ts
import * as ProcessLedger from "@smthrs/kernel/ProcessLedger"
import { BunHost } from "@smthrs/platform-bun"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as ChildProcess from "effect/process/ChildProcess"
import { ChildProcessSpawner } from "effect/process/ChildProcessSpawner"

const program = Effect.gen(function*() {
  const ledger = yield* ProcessLedger.makeMemory({
    hostId: "quickstart",
    ownerPid: process.pid
  })

  const host = BunHost.layerContained({ graceMs: 500 }).pipe(
    Layer.provide(Layer.succeed(ProcessLedger.ProcessLedger)(ledger))
  )

  const duringScope = yield* Effect.gen(function*() {
    const spawner = yield* ChildProcessSpawner
    yield* spawner.spawn(ChildProcess.make("sleep", ["30"]))
    return yield* ledger.live
  }).pipe(Effect.provide(host), Effect.scoped)

  return { afterScope: yield* ledger.live, duringScope }
})

Effect.runPromise(program).then((result) => console.log(JSON.stringify(result, null, 2)))
```

Run it:

```bash
bun run contained.ts
```

```text
{
  "afterScope": [],
  "duringScope": [
    {
      "pid": 51234,
      "pgid": 51234,
      "hostId": "quickstart",
      "ownerPid": 51230,
      "startedAtMs": 1756900000000,
      "commandDigest": "sleep"
    }
  ]
}
```

The recorded pid is the live supervisor, which leads the owned process group;
it is not the native `sleep` target's pid. `commandDigest` names the executable
and never its arguments: journal entries are permanent, and arguments carry
credentials. A returned handle's `exitCode`
describes the target. The record also names the host incarnation that started
it, and it is gone after verified scope cleanup. See
[Contain and reap child processes](./guides/contain-child-processes.md) for
the `detached: false`, escaped-session, and unsupported-platform boundaries.

Give it a durable half by swapping `ProcessLedger.makeMemory` for
`ProcessLedger.layer`, which writes through a [`@smthrs/journal`](/api/journal)
`Journal`. Then a crashed host's records survive, and the next incarnation
kills what the last one abandoned while its layer is built.

## The same walkthrough in VibeLang

In [VibeLang](https://github.com/smithersai/vibelang) both programs are
`effect` functions, and the caller provides `BunHost.layer` to the first. A
`.vibe` file reads no Node globals, so `fileAndCommand` takes the directory to
work in and `contained` takes the owner pid the TypeScript read from
`process.pid`. `scoped` closes the contained host's scope before the second
ledger read.

This is `examples/quickstart.vibe`. `test/quickstart.test.vibe` runs it, and
the package's docs check fails if this block and the file differ.

```vibe
import * as ProcessLedger from "@smthrs/kernel/ProcessLedger"
import { BunHost } from "@smthrs/platform-bun"
import * as ChildProcess from "effect/process/ChildProcess"
import { ChildProcessSpawner } from "effect/process/ChildProcessSpawner"

/** Writes and reads a file, then lists it with a real `ls`. It asks for two host services by tag and names Bun nowhere. */
export effect function fileAndCommand(directory: string) {
  const fs = try FileSystem.FileSystem
  const spawner = try ChildProcessSpawner

  try fs.writeFileString(`${directory}/report.txt`, "written through the host filesystem\n")
  const readBack = try fs.readFileString(`${directory}/report.txt`)
  const listed = try spawner.string(ChildProcess.make("ls", ["report.txt"], { cwd: directory }))

  return { listed: listed.trim(), readBack: readBack.trim() }
}

/** Spawns `sleep 30` under containment and reads the process ledger during and after the scope. */
export effect function contained(ownerPid: number) {
  const ledger = try ProcessLedger.makeMemory({ hostId: "quickstart", ownerPid })
  const host = Layer.provide(BunHost.layerContained({ graceMs: 500 }), Layer.succeed(ProcessLedger.ProcessLedger, ledger))

  const duringScope = try scoped(Effect.provide(effect {
    const spawner = try ChildProcessSpawner
    try spawner.spawn(ChildProcess.make("sleep", ["30"]))
    return try ledger.live
  }, host))

  return { afterScope: try ledger.live, duringScope }
}
```

## Where to go next

- [Contain and reap child processes](./guides/contain-child-processes.md):
  the escalation deadline, the reaper, and the options both contained
  factories take.
- [Bind the host to a repository root](./guides/bind-a-repository-root.md):
  `layerAt` and `layerContainedAt`, so `Jj` does not inherit the process
  working directory.
- [The Host surface on Bun](./concepts/host-surface.md): what each of the five
  slots is, and how to take one service without the other four.
