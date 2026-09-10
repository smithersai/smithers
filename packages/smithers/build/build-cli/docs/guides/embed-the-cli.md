---
title: "Embed the CLI in another program"
description: "Drive smithers-build from a host process: makeCli with injected terminals and an AbortSignal, Entry.main against a fake process, and the fakes that make a run deterministic."
sidebar:
  order: 5
---

A test harness, a hosted runner, or a wrapper CLI can run the same commands
the binary runs, with every ambient fact supplied rather than read.

## Serve a command with injected state

`makeCli(config)` returns the configured CLI. `serve` takes the argv:

```ts
import { makeCli } from "@smthrs/build-cli"
import { normalizeArgv } from "@smthrs/build-cli/Cli"
import * as Reporter from "@smthrs/build-cli/Reporter"

const lines: Array<string> = []
const terminal: Reporter.Terminal = {
  write: (text) => {
    lines.push(text)
  },
  isTTY: false,
  columns: 80
}

const controller = new AbortController()

await makeCli({
  signal: controller.signal,
  environment: { PATH: process.env["PATH"] },
  stdout: terminal,
  stderr: terminal
}).serve([...normalizeArgv(["test", "//:greet", "--ui", "plain"])], {
  exit: (code) => {
    process.exitCode = code
  },
  stdout: (text) => terminal.write(text)
})
```

Everything in `RuntimeConfig` is optional, and each field replaces something
the process would otherwise supply.
[`RuntimeConfig`](../api.md#runtimeconfig) is the field-by-field inventory:
the CLI's own name, version and description, the remote cache credentials, the
interruption signal, the environment, both terminals, the audience policy, and
the exit hook. Two of them decide how deterministic an embedded invocation is.

`presentation` fixes the audience. Without it the run detects one from the
injected environment and the terminals' `isTTY`, so the same argv renders
differently under a PTY than under a pipe. Pass an `Audience.Policy` and every
renderer reads that instead. Explicit presentation flags in the argv still
override it.

`exit` is the other field to think about. Deciding a process's exit code is a choice
only a process owner may make, so `makeCli` never sets one. Supply the setter
when you own the process; omit it when you want the structured error back
instead.

`normalizeArgv` lives on `@smthrs/build-cli/Cli` rather than in the root
barrel, and it is separate on purpose. Apply it if you want the bare-label
form (`["//:greet"]` becoming `["target", "//:greet"]`); skip it if your
wrapper has its own argv rules.

## Run a whole invocation against a fake process

`Entry.main` is one step up: it takes a `Host`, the slice of `process` the CLI
touches, and does the credential capture, the signal wiring, and the argv
rewrite itself.

```ts
import * as Entry from "@smthrs/build-cli/Entry"
import * as NodeEvents from "node:events"

const signals = new NodeEvents.EventEmitter()
const codes: Array<number> = []
const env = { ...process.env }

await Entry.main({
  argv: ["test", "//:greet", "--ui", "plain"],
  env,
  stdout: terminal,
  stderr: terminal,
  on: (signal, listener) => {
    signals.on(signal, listener)
  },
  removeListener: (signal, listener) => {
    signals.removeListener(signal, listener)
  },
  setExitCode: (code) => {
    codes.push(code)
  }
})
```

Two facts about `Host` matter when you implement it.

`env` is mutated. `Entry.main` deletes `SMITHERS_CACHE_URL` and
`SMITHERS_CACHE_TOKEN` from the object you pass, before any declaration
evaluates. Pass a copy if the caller still needs those names.

`on` must register a persistent listener, never a one-shot one. The service
supervisor's orphan backstop asks `listenerCount(signal)` whether anything
else owns the signal and hard-kills the process when the answer is that it
stands alone. Node removes a one-shot listener before invoking it, so a `once`
registration surrenders the signal at exactly the moment the backstop looks. A
`Map`-backed fake cannot tell the two apart, which is why the tests back the
signal surface with a real `EventEmitter`.

## Make a run deterministic

Three seams remove the nondeterminism a real run carries.

**The renderer.** Pass `--ui plain` or set `SMTHRS_UI=plain` in the injected
environment. The plain renderer prints one line per settled target and one
summary, with no colour and no cursor motion, so assertions read text rather
than escape sequences.

**The agent CLI.** Set `SMTHRS_AGENT_FAKE=<script.json>` in the injected
environment and agent targets replay that script instead of spawning `claude`
or `codex`. The fake records exact spawn accounting, so a test can assert that
a cached verdict spawned nothing.

**The signal.** Abort your own `AbortController` rather than raising a real
signal, unless the thing under test is the signal path itself.

## Run the install flow directly

`runInstall` is the programmatic form of the install path, bypassing the
command surface:

```ts
import { runInstall } from "@smthrs/build-cli"

const result = await runInstall("/path/to/workspace", {
  signal: controller.signal
})
```

It refuses any `cacheDirectory` other than `.flows`, because the package
manager's store boundary is fixed there. It is scoped per call, so concurrent
callers may run against different workspaces at the same time. Note that it is
not what the `install` verb runs: that verb executes the root `PACKAGE.ts`
`Install` target through the ordinary executor.

## What is public

The root entry point is a curated barrel. Every module is also importable by
its own path, whether or not the barrel names it:

```ts
import { Planner, Workspace } from "@smthrs/build-cli"
import * as Reporter from "@smthrs/build-cli/Reporter"
```

`@smthrs/build-cli/internal/*` is not public. See the
[API reference](../api.md).
