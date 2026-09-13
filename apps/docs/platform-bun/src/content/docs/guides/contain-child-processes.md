---
title: "Contain and reap child processes"
description: "Compose BunHost.layerContained with a ProcessLedger so each command has a supervised process group, a cleanup deadline, and a durable identity for restart reconciliation."
editUrl: "https://github.com/smithersai/smithers/edit/main/packages/smithers/flows/platform-bun/docs/guides/contain-child-processes.md"
---

`BunHost.layer` provides the raw process service. A scope finalizer can signal
its target, but a target that exits first can leave descendants holding output
open. A crashed host runs no finalizers at all.

`BunHost.layerContained` combines a live process owner with a ledger for
cleanup that a later host must reconcile.

## What containment adds

**A live owner and deadline.** Every pipeline leg gets a prepared POSIX
supervisor. Its lifetime is independent of the native target, so cleanup can
stop the owned group even after the target exits. The default policy is
`SIGTERM`, then `SIGKILL` after `graceMs`; an explicit `killSignal` or
`forceKillAfter` is preserved. A private connection also initiates cleanup
when the host disappears.

**A durable record before execution.** The kernel records the prepared
supervisor's identity and the executable it runs before activation starts the
target. The record carries the owner pid and group, host identity, host
incarnation pid, and start time. Only verified cleanup retires it; failed or
unverified cleanup fails scope release and retains the record.

`commandDigest` names the program and never its arguments, because a
journal-backed ledger keeps every record permanently and arguments carry
credentials: `curl -u user:pass`, `mysql -phunter2`, `deploy --token hunter2`.
Nothing that reads a record needs more, since the reaper matches on pid and
process group. Keep credentials out of argv anyway, in the environment or on
stdin: while a child runs, its arguments are readable through `ps`.

**A sweep on the way up.** While the layer is built,
[`@smthrs/platform-node`](https://platform-node.smithers.sh/reference/api/)'s `ProcessReaper` reads the
records a previous incarnation of the same `hostId` left behind and signals the
groups they name after checking their identities. The lifecycle and reaper
live in the Node package and support ordinary Node and Bun runtimes.

On POSIX, a returned handle's `pid` identifies the supervisor; `exitCode` and
`isRunning` describe the target. Signal through `handle.kill`, not either
numeric pid. `detached: false` retains a supervisor but opts out of group
cleanup, signalling only the target. Explicit stopping while a grouped target
is still alive also attempts a revalidated positive-PID sweep of escaped
descendants. That extra sweep is best effort; natural exit does not promise
cleanup of deliberately escaped sessions. Windows remains unsupported best
effort. Node single-executable applications and compiled Bun executables are
refused before activation because the supervisor needs a runtime eval entry
point.

## Compose it

The ledger is a layer requirement rather than a built-in default, because only
your program knows whether it has a durable one:

```ts
import * as ProcessLedger from "@smthrs/kernel/ProcessLedger"
import { BunHost } from "@smthrs/platform-bun"
import * as Layer from "effect/Layer"

const host = BunHost.layerContainedAt("/srv/repositories/app", {
  graceMs: 2_000,
  ownerPid: process.pid
}).pipe(
  Layer.provide(ProcessLedger.layerMemory({ hostId: "worker-a", ownerPid: process.pid }))
)
```

`ProcessLedger.layerMemory` records nothing durably. A host built on it still
contains the process groups it owns, including when the host connection closes,
but it inherits nothing from a previous incarnation, so the reaper has nothing
to sweep. Use it in tests and in short-lived programs.

`ProcessLedger.layer` writes through a [`@smthrs/journal`](https://journal.smithers.sh/reference/api/)
`Journal`, which is what makes the durable half real. Give two incarnations the
same `hostId` and the second inherits the first's unreleased records.

## The options both contained factories take

`BunHost.ContainedOptions` is the containment configuration plus the reaper's:

| Field      | Meaning                                                                                                               |
| ---------- | --------------------------------------------------------------------------------------------------------------------- |
| `graceMs`  | Milliseconds between the `SIGTERM` that asks a child to stop and the `SIGKILL` that makes it. Default 2000.           |
| `ownerPid` | The pid this host must never signal a group for, so it cannot kill itself. Default `process.pid`.                     |
| `system`   | The operating-system seam the reaper reads liveness and start times through. Default: chosen from `process.platform`. |

Each factory reads the options when you call it, not when the layer is built,
and splits them into the two halves so a field meant for one can never be read
by the other. Mutating the object you passed afterwards changes neither layer.

## Why there is no `platform` option

`ContainedSpawner.Options` has a `platform` field. `ContainedOptions` omits it,
deliberately.

The contained factories use `ProcessReaper.layerSpawner`, which reads the real
`process.platform`. The native process-group behavior and recorded identity
must agree: a caller cannot describe a Windows record for an owner that
actually leads a POSIX group. Casting `platform: "win32"` past the type does
not override the running platform.

For a smaller Bun composition, use `ProcessReaper.layerSpawner` with a ledger
and an underlying runtime spawner. It includes the prepared native adapter
whose pipe error listeners remain alive through cancellation. Keep the kernel
permission decorator above it to authorize the caller's command before
preparation.

## `jj` is contained too

Under `BunHost.layer`, the `Jj` slot spawns the jj CLI through
`node:child_process` directly. A jj child therefore leads no group the host
recorded, appears in no ledger, and outlives the host that ran it.

`layerContained` and `layerContainedAt` build `Jj` over the contained spawner
(`BunJj.layerSpawner` and `BunJj.layerSpawnerAt`) rather than around it, so a
`jj` invocation is a ledger record like any other child:

```ts
import { Jj } from "@smthrs/jj"
import * as Effect from "effect/Effect"

// The ledger records the jj executable while status runs, and retires it when the
// invocation and its cleanup finish.
const status = Effect.flatMap(Jj, (jj) => jj.status()).pipe(
  Effect.provide(host),
  Effect.scoped
)
```

That is the observable difference: the same call under `BunHost.layer` leaves
the ledger empty. The initial `jj --version` probe uses the selected runner
too, so a contained host records and retires it before exposing `Jj`. Probe
results are cached per resolved absolute executable path and runner, with a
separate cache for each spawner instance.

Every aggregate host waits up to 5000 ms for the startup probe, then interrupts
it and awaits process cleanup. The typed `JjError` has `method: "version"`,
`code: "unknown"`, `cause.code: "ETIMEDOUT"`, and the executable path in its
command and message. Cleanup can add the contained spawner's shutdown grace
period to the startup budget. Raw hosts close the probe's pipes and kill its
direct child; they do not add a ledger entry.

Override the budget per host layer through the shared Node and Bun adapter:

```ts
import * as NodeJj from "@smthrs/jj/node/NodeJj"

const boundedHost = host.pipe(
  Layer.provide(Layer.succeed(NodeJj.StartupTimeoutMs)(1_500))
)
```

The budget is a positive, finite number of milliseconds, at most 2147483647.
Timeout and interruption allow a later construction to retry the probe.

## What the reaper refuses to kill

A record is not a licence to signal. `ProcessReaper.reap` re-checks each
inherited record and declines when the numbers do not clearly name an
abandoned process: the owning incarnation is still alive, the record names this
host's own group, the pid is gone, the pid exists but did not start when the
record says it did, the record predates the machine's boot, or the host could
not ask the question at all.

Four refusals leave the record inherited rather than retiring it:
`owner-alive`, `identity-unverified`, `own-group-unknown`, and `kill-failed`. A host that
could not ask, or that has no business signalling, must not be the one that
closes the question. A later incarnation that can ask gets the chance.

## Related

- [Bind the host to a repository root](/guides/bind-a-repository-root/): what
  `layerContainedAt` adds beyond containment, and the refusal it throws.
- [Quickstart](/quickstart/): a runnable version of the composition above.
