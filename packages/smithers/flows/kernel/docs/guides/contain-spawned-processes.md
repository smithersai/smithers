---
title: "Contain spawned processes"
description: "Compose ContainedSpawner and ProcessLedger so a cancelled run kills its children on a deadline and a crashed host leaves records its successor can reap."
sidebar:
  order: 6
---

Without containment, a spawned child that ignores `SIGTERM` hangs a
cancellation forever, and a host that crashes abandons every process it
started. This guide composes a platform lifecycle and a process ledger to own cleanup.

## Compose the spawner over the ledger

On Node or Bun, `ProcessReaper.layerSpawner` supplies the native adapter,
prepared lifecycle, and kernel containment together. It requires
`ChildProcessSpawner` (which it also provides) and `ProcessLedger`:

```ts
import { ProcessLedger } from "@smthrs/kernel"
import * as ProcessReaper from "@smthrs/platform-node/ProcessReaper"
import { Layer } from "effect"

const contained = ProcessReaper.layerSpawner({ graceMs: 2000 }).pipe(
  Layer.provide(rawSpawner),
  Layer.provideMerge(ProcessLedger.layer({ hostId: "my-host", ownerPid: process.pid }))
)
```

`graceMs` is the interval between the `SIGTERM` that asks a child to stop and
the `SIGKILL` that makes it. It defaults to `ContainedSpawner.defaultGraceMs`
(2,000 ms).

The factory always uses the real `process.platform`. A custom host can use
`ContainedSpawner.layer(options, lifecycle)` directly; its `platform` option
must describe the real process-group behavior. A win32 record claiming
`pgid === pid` would name a group the child does not lead.

The lifecycle prepares an owner before the command starts, records its
identity, and only then activates the target. Each pipeline leg has its own
record. Node and Bun use a live supervisor to keep group ownership after the
target exits; its `pid` names that owner while `exitCode` and `isRunning`
describe the target. A raw or deadline-only wrapper has no such contract and
`ContainedSpawner.isContained` returns false for it.

Compose the kernel permission decorator **above** containment. That order
checks the caller's whole command before pipeline expansion or platform
preparation. A permission decorator below it can see the trusted supervisor
command instead of the command the caller requested.

## Choose a ledger

```ts
// Durable: inherits a crashed incarnation's processes. Requires a `Journal`.
ProcessLedger.layer({ hostId, ownerPid })

// In-memory: contains this incarnation and inherits nothing. No journal.
ProcessLedger.layerMemory({ hostId, ownerPid })
```

The durable half is only as good as the journal underneath it, so the choice
belongs to the program that knows which it has. `hostId` names the run the
records live on (`flows.host:<hostId>`), and `ownerPid` is the pid the reaper
probes to learn whether a record's owner is still running. Each record also
carries a nonce drawn once per process; `ownerPid` and that nonce together
distinguish this incarnation's processes from the orphans a previous one left,
even when the successor was given the same pid.

On Node, `@smthrs/platform-node`'s `NodeHost.layerContained` and
`layerContainedAt` compose the spawner, bind `Jj` through it so a stray `jj`
invocation is recorded too, and add the `ProcessReaper` that sweeps inherited
records before handing the host over. You supply the ledger.

## Handle a failed record

`record`, `release`, `reaped`, and `skipped` all carry the journal's failure to
their caller, and the spawner acts on it: a spawn whose durable record fails is
cleaned up before target activation, and the call fails. Failed startup closes
its own scope even if the caller catches the failure and keeps an outer scope
open. A cleanup failure or an unverified result fails release and retains any
record already committed; only the lifecycle's successful `settled` result
permits retirement.

The release finalizer is the exception, because it has nowhere left to report.
A missed release leaves the record inherited, and the next reaper finds the pid
already gone and retires it.

## Read what is running and what was abandoned

```ts
const ledger = yield * ProcessLedger.ProcessLedger

const running = yield * ledger.live // this incarnation's unreleased records
const abandoned = yield * ledger.orphans // records whose owner pid is not ours
```

`orphans` replays the host's journal history, folds the exit, reap, and skip
events onto the spawn events, and returns what is left. A host that wants to
clean them up signals each group and then retires the record:

```ts
yield * ledger.reaped(record) // we signalled it
yield * ledger.skipped(record, "pre-boot") // we refused to, and why
```

Use two different calls deliberately. An operator reading the journal can then
tell "we killed it" from "we declined to", which a single retire event would
erase.

Signalling a process group you did not start is dangerous, because a pid can be
recycled. Before reaping, verify that the record names a separate process group
rather than your own, that the owner is gone, that the record belongs to the
current boot, and, where the platform can read it, that the pid's start time
still matches. `@smthrs/platform-node`'s `ProcessReaper` implements exactly
those checks; reuse it rather than writing the comparisons again.

## Related

- [Process containment](../concepts/process-containment.md): why each of these
  pieces exists.
- [Guard a host bundle](./guard-a-host-bundle.md): containment inside the full
  host composition.
