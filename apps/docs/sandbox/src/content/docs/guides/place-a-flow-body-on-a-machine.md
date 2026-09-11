---
title: "Place a flow body on a machine"
description: "Use Sandbox.layerHost to give one action's implementation the filesystem and spawner of a provisioned session while the durable engine stays where it is."
sidebar:
  order: 1
editUrl: "https://github.com/smithersai/smithers/edit/main/packages/smithers/flows/sandbox/docs/guides/place-a-flow-body-on-a-machine.md"
---

Placement decides which machine supplies the host services a body sees. The
engine still plans the flow, dispatches the action, and journals its result
locally. Only the implementation layer is given `Sandbox.layerHost`, so its
file operations and child processes reach one provisioned session instead of
the engine host.

The complete program this guide walks through is
[`examples/src/40-sandbox-placement.ts`](https://github.com/smithersai/smithers/blob/main/examples/src/40-sandbox-placement.ts).

## What layerHost provides

```ts
import { Sandbox } from "@smthrs/sandbox"

const host = Sandbox.layerHost(provider, {
  session: "run:01J...",
  health: { deadline: "10 seconds" }
})
```

It acquires one session for the layer's lifetime and provides four services
from it:

- `ChildProcessSpawner`, adapted from `Session.spawn`.
- `FileSystem`, derived from `Session.readFile`, `Session.writeFile`, and the
  native operations the session declares in `files`, with POSIX `sh` probes
  for the rest.
- `Path`, the pure implementation.
- `SandboxHealth`, probing the machine this layer holds. `options.health` is
  the probe's `ProbeOptions`; its `deadline` defaults to 5 seconds.

These are the same tags the local platform bundles provide, which is why a
body written against Effect's ordinary services runs unchanged.

## Keep the graph independent of the placement

The action's declaration says nothing about where it runs. Only the
implementation layer does. `Action`, `Flow`, and `Interpreter` come from
[`@smthrs/flow`](https://flow.smithers.sh/reference/api/), the authoring model, which
[`@smthrs/flows`](https://flows.smithers.sh/reference/api/) also re-exports if you installed the whole
engine:

```ts
import { Action, Flow, Interpreter } from "@smthrs/flow"
import { DirectorySandbox, Sandbox } from "@smthrs/sandbox"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Schema from "effect/Schema"

const CountBytes = Action.make("examples/SandboxPlacement/CountBytes", {
  payload: { contents: Schema.String },
  success: Schema.Number
})

const SandboxPlacement = Flow.make("examples/SandboxPlacement", {
  payload: { contents: Schema.String },
  success: Schema.Number,
  body: (payload) => CountBytes.call(payload)
})

const placedHost = Sandbox.layerHost(
  DirectorySandbox.make({ fs, spawner, root: "/var/tmp/smithers" }),
  { session: "examples/sandbox-placement" }
)

const stack = Layer.mergeAll(
  CountBytes.toLayer((payload) => writeAndCount(payload).pipe(Effect.provide(placedHost), Effect.orDie)),
  Interpreter.layer(SandboxPlacement)
).pipe(Layer.provideMerge(Action.layerImplementations))
```

`fs` and `spawner` above come from a contained host, such as
`NodeHost.layerContained()` provided with a `ProcessLedger`; the
[quickstart](/quickstart/) shows that composition. `DirectorySandbox`
refuses raw or deadline-only spawners before creating its workspace.

The action execution scope owns the host layer, so completing the action closes
that scope, releases the session, and removes its workspace. The engine and its
journal stay open over whatever they were composed with. Swapping
`DirectorySandbox` for `ContainerSandbox` or `MicrosandboxSandbox` changes this
one construction and nothing else.

## Write relative paths

`Sandbox.fileSystem` resolves a relative path against `Session.workdir` before
it reaches the session or a native override, so a body that writes
`report.txt` lands in the machine's workspace on every backend. The session
contract itself stays absolute only; the rooting rule lives in one place.

Absolute paths are passed through unchanged, which means an absolute path names
a location on the machine and not in the workspace.

## What the derived filesystem can and cannot tell you

Operations the session declares in `files` are served natively. Reads and writes
otherwise use the session's byte transfer operations; other supported operations
use POSIX `sh` probes. The derived filesystem has these limits:

- `writeFile` and `writeFileString` support replacement with an omitted `flag`
  or `flag: "w"`, and no `mode`. Every other flag, including `"a"` and `"wx"`,
  and every explicit mode fail with a typed `PlatformError` reason
  `BadArgument` before session access. The byte transfer contract cannot
  guarantee atomic append, exclusive creation, or creation permissions.
  Native write overrides in `Session.files` receive the options unchanged
  and define their own supported set.
- `stat` reports exact file size, read from the machine's own `stat` where it
  has one (GNU, busybox, and BSD spellings) and counted with `wc` otherwise. A
  size the probe cannot read, such as a mode `000` file on a machine without
  `stat`, fails with reason `Unknown` rather than reporting zero. Mode is `0`,
  and times and ownership are absent, because the portable shell cannot name
  them.
- `rename` refuses a file onto an existing directory with reason `BadResource`,
  as `rename(2)` does. A directory may replace an empty directory or name
  itself; the replacement runs through `mv -T`, so a machine whose `mv` lacks
  `-T` (BSD) refuses it with `BadResource` and changes nothing.
- Directory listings are line framed, so a filename containing a newline is
  misread. The listing probe is `ls -1A` and never a bare `ls -A`, because
  POSIX `ls` columnizes when its output is a terminal and one provider's
  transport is a pseudo-terminal.
- Operations with no meaningful remote form (a watch, an open file handle, a
  temporary directory) answer with the platform's own refusal rather than a
  plausible lie.
- The probes require the named POSIX utilities on the machine.

## A dead machine fails the action

`layerHost` deliberately does not retire an unhealthy session and open a fresh
one behind your back, which is what
[`SandboxSupervision`](/guides/supervise-a-session/) does for a transport. The body
holding these services has been writing to this machine, so swapping it mid
action would discard those writes and hand the body an empty tree that still
looks like its workspace.

A dead machine surfaces as a failure. Re-provisioning belongs to whoever
retries the action, and the retry acquires the session key again.

## Read next

- [Choose a provider](/guides/choose-a-provider/).
- [What a sandbox does and does not prevent](/concepts/isolation/): these
  services are served bare, without a kernel capability decorator.
