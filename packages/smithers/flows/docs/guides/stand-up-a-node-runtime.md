---
title: "Stand up a durable Node runtime"
description: "Choose between NodeRuntime.layerHost, layer, make, and storage; supply the owner identity and liveness probe the engine needs; and know which layers each entry point builds for you."
sidebar:
  order: 1
---

`@smthrs/flows/NodeRuntime` has four entry points. They differ in one thing:
how much of the composition they decide for you.

| Entry point | Returns                                           | You still supply                                                                   |
| ----------- | ------------------------------------------------- | ---------------------------------------------------------------------------------- |
| `layerHost` | A `Layer` with no requirements                    | Nothing. It builds the host, the kernel, storage, the engine, and signal handling. |
| `layer`     | A scoped `Layer`                                  | `Crypto`, `FileSystem`, `Jj`, a `StepBoundary`, and a `WorkspaceSandbox`.          |
| `make`      | An `Effect` that builds the context in your scope | The same five, and the surrounding `Scope`.                                        |
| `storage`   | A `Layer` of migrated stores                      | Everything else, including the engine.                                             |

Start at the top of that table and move down only when a decision it makes for
you is one you need to make differently.

## Use `layerHost` for a single-process Node program

`layerHost` exists so a program does not restate the same eight layers to get a
durable engine. `filename`, `workspaceRoot`, and `owner` are required;
everything else has a default a single-process program can live with.

```ts
import * as NodeRuntime from "@smthrs/flows/NodeRuntime"

const host = NodeRuntime.layerHost(
  {
    filename: ".flows/engine.db",
    workspaceRoot: ".",
    owner: { hostId: "local-worker" }
  },
  registerFlows
)
```

What it adds over `layer`:

- The complete Node host from [`@smthrs/platform-node`](/api/platform-node),
  with process containment on. A spawned process gets its own process group, is
  signalled and then killed when its action's scope closes, and is recorded in
  the `ProcessLedger` so the next incarnation of this host reaps whatever a
  crash left running.
- The kernel's guarded host surface over an unattended `GrantStore`, so an
  action reaches the host through the capability check rather than around it.
- The default `StepBoundary` and the filesystem `WorkspaceSandbox`. That pairing
  is what makes a sealed action's result eligible for the step cache: the
  sandbox runs the body in an isolated workspace and observes the whole tree, so
  the boundary evidence can honestly claim the whole tree was verified.
- Signal handling. See [Shut a host down](./shut-a-host-down.md).

Engine bookkeeping and action authority are separate. The engine takes its
compensable snapshots through a private `Jj` service, so `HostOptions.rules`
governs only what a flow body can reach. Denying `jj:*` to actions does not
disable the engine's own snapshots.

## Registration is the last startup phase, not a sibling layer

`registerFlows` is an argument rather than a layer you merge beside the engine,
and the ordering is the reason. The runtime becomes usable only after every
supplied registration has completed, so a persisted run cannot resume through
this composition before its flow has been registered.

```ts
import { Action, Interpreter } from "@smthrs/flows"
import * as Layer from "effect/Layer"

const registerFlows = Interpreter.layer(MyFlow).pipe(
  Layer.provideMerge(MyAction.toLayer(implementation)),
  Layer.provideMerge(Action.layerImplementations)
)
```

## Supply an honest liveness probe

`Options.isAlive` on `layer` and `make` is required, and a stub is not an
answer. A check that returns `false` without asking says "that owner is gone"
about an owner it never looked at, and the engine will steal runs out of live
processes on the strength of it.

- A single-machine host passes `Ownership.sameHostPidProbe` from
  [`@smthrs/run-store`](/api/run-store), which asks this machine's process
  table for owners on the same host. For a foreign host it returns `false`
  without probing a PID, leaving the expired lease to decide takeover.
  `RunStore.steal` still requires the lease to have expired.
- A multi-process deployment answers from its supervisor or lease system.

`layerHost` defaults `isAlive` to `HostLiveness.isAlive({ hostId })` from
[`@smthrs/platform-node`](/api/platform-node). This probe returns `true` for
foreign-host owners, refusing takeover even after their lease expires.

## Drop to `layer` when you own the host

`layer` composes storage and the engine and leaves the host to you: `Crypto`,
`FileSystem`, and `Jj` stay requirements, and the step boundary and workspace
sandbox are arguments. `WorkspaceSandbox.layerFileSystem()` needs a
`FileSystem` that makes descriptor-relative, no-follow requests, such as
`AtomicFileSystem.layer` from [`@smthrs/platform-node`](/api/platform-node);
over a plain `NodeFileSystem.layer` it fails to build with `host_unavailable`.

```ts
import { StepBoundary, WorkspaceSandbox } from "@smthrs/engine-store"
import * as NodeRuntime from "@smthrs/flows/NodeRuntime"
import { Ownership } from "@smthrs/run-store"

const engine = NodeRuntime.layer(
  {
    filename,
    workspaceRoot,
    owner: { hostId: "worker-1" },
    isAlive: Ownership.sameHostPidProbe
  },
  StepBoundary.layer,
  WorkspaceSandbox.layerFileSystem(),
  registerFlows
)
```

Use it when your program already has a host, a different capability policy, or
its own signal wiring. Nothing `layerHost` provides is reachable only through
`layerHost`.

`make` is the same composition as an `Effect` that builds the service context in
your current scope, for a program that wants the context rather than a layer.
Closing the surrounding scope closes the database, the journal writer, the
sweeper, and the active engine fibers through their existing finalizers.

## Drop to `storage` to share a database with another service

`storage(filename, workspaceRoot?)` provides the migrated database, the durable
stores, the owner minter, the workspace, and a local artifact store, and
constructs no engine. It is the seam for building another engine-backed service
over the same storage context.

```ts
import * as NodeRuntime from "@smthrs/flows/NodeRuntime"

const stores = NodeRuntime.storage(".flows/engine.db", ".")
```

`workspaceRoot` defaults to the database's own directory. Artifacts live beside
the database under `objects/`, so a database at `<root>/.flows/engine.db` puts
its blobs in `<root>/.flows/objects` rather than nesting a second `.flows`.

## Options are validated and frozen at the call

Both `layer` and `layerHost` validate when they are called, not when the layer
builds, and they snapshot every option they were given. Two consequences worth
knowing:

- A bad option throws a `RuntimeConfigurationError` naming the field, before
  anything opens a database. See [Troubleshooting](../troubleshooting.md).
- Mutating the options object after the call changes nothing. Relative paths
  are resolved once, against the working directory as it stood at the call, and
  rule arrays, signal lists, and containment callbacks are all copied.

## The journal queue is fixed

The runtime journal queue has capacity 1,024 and rejects overflow rather than
dropping or blocking. That is a deliberate bound, not an option: a journal that
silently dropped events would make a replay wrong.
