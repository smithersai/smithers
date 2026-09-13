---
title: "Inject a real process fault"
description: "Kill a real process and prove the fault landed: the pid helpers, the orphan test, the wall-clock skew, and where a fault suite has to live so it cannot reach a neighbour."
sidebar:
  order: 8
editUrl: "https://github.com/smithersai/smithers/edit/main/packages/testing/docs/guides/inject-a-process-fault.md"
---

`@smthrs/testing/Faults` is not a double. It sends real signals to real pids,
reads what the operating system did with the survivors, and moves the wall
clock a durable timer is measured against.

It is deliberately absent from the root barrel, so the decision is visible at
the import site:

```ts
import { isAlive, killProcess, waitFor, waitForReparent } from "@smthrs/testing/Faults"
```

## Kill a process and prove it died

```ts
await killProcess(engine.process)
```

`killProcess` sends the signal (`SIGKILL` by default) and does not return until
the operating system has reaped the pid. A pid that was already dead is an
**error**, not a no-op: the test that called this believed it was injecting a
fault, and it was not. A suite that "killed" a corpse would report green over a
fault it never caused.

The pid must be a positive integer. Missing, zero, negative, fractional, and
non-finite pids reject with `killProcess: invalid pid` before any signal is sent.

## Wait for the state you are asserting on

A fault landing is asynchronous. `waitFor` polls a predicate until it holds, or
fails with a message naming what it waited for. Poll evidence the process under
test wrote down, such as an append-only marker file it opens on boot:

```ts
import * as fs from "node:fs"

const markerLog = "/tmp/flow-run-markers.log"
const markers = () => fs.existsSync(markerLog) ? fs.readFileSync(markerLog, "utf8") : ""

await waitFor(() => markers().includes("second-started"), "the second action to start", 60_000)
```

Every helper takes an optional timeout as its last argument.

## Read the orphan a kill leaves behind

Containment claims have to be measured, not assumed. A child whose parent was
killed is reparented, and on macOS and Linux the new parent is pid 1 or a
subreaper:

```ts
const reparented = await waitForReparent(orphan, engine.process.pid!)
```

`waitForReparent` waits because reparenting is not instantaneous: the kernel
moves the child when the old parent is reaped, which is after the signal was
delivered. A suite that reads `parentPid` once races that.

`parentPid(pid)` is the single-shot read, answering `undefined` when the process
is gone. `isAlive(pid)` and `isGroupAlive(pgid)` use signal 0, which performs
the permission and existence check without delivering anything: `ESRCH` is the
only answer that means "gone", while `EPERM` means the process exists and
belongs to somebody else.

`killGroup(pgid)` tears down a whole process group and never throws, because it
is teardown for what a test deliberately orphaned. Pass a positive integer
group id; the helper negates it internally to address the group. Invalid group
ids are a no-op. `isAlive` and `isGroupAlive` return `false` for invalid identifiers
without signalling.

## Skew the wall clock

A durable timer is measured against the wall clock, and a test that has to
cross a deadline should move the clock rather than wait:

```ts
import { skewClock } from "@smthrs/testing/Faults"

const clock = skewClock(60_000)
clock.advance(30_000)
clock.restore()
```

`skewClock` patches `Date.now`, `Date()`, and a bare `new Date()` **for this
process only**. `Date()` returns the skewed instant as a string. Explicit Date
constructor arguments, the prototype, and static parsing helpers are preserved.
A child process does not inherit the skew, so a child runner takes an explicit
skew instead.

Each skew is relative to the real clock, and the latest installation controls
the global clock. Restoring any live handle reinstalls the Date constructor and
`Date.now` captured at module load, including when handles are restored out of
order. `restore` is idempotent and does not resume an earlier skew. Use
`try`/`finally` to restore the clock when an assertion fails.

## Where a fault suite has to live

Pids, process groups, ports, and the durable database under a fixture are
machine global. A fault suite therefore gets its own tier:

- Put the cases in their own tree, such as `test/faults`, so the default suite
  never picks them up.
- Give that tree its own vitest config with `fileParallelism: false`, a finite
  `testTimeout`, and coverage disabled, because the work happens in child
  processes this one never instruments.

A suite that signals only pids it spawned itself can reach no neighbouring
suite, so it is safe to leave in the default tree. A case that kills a process
another suite owns is not: it belongs with the code that owns that process.

## Admit the run before you claim anything

A kill proves something only if the thing it killed was really running. Boot
the real process, wait until it reaches the state you are about to disturb,
assert that state, and only then inject:

```ts
import { spawn } from "node:child_process"
import { expect } from "vitest"

const child = spawn(process.execPath, ["./run-flow.mjs"], {
  env: { ...process.env, MARKER_LOG: markerLog }
})

await waitFor(() => markers().includes("second-started"), "the second action to start", 60_000)

expect(markers()).toContain("first-done")
expect(markers()).not.toContain("second-done")

await killProcess(child)
```

`killProcess` takes anything carrying a `pid`, so a `ChildProcess` handle goes
straight in.

Read the durable evidence out of an append-only file the killed process could
not have rewritten, and out of the run's own journal. Anything read from the
killed process is a claim about a process that is gone.

## Related

- [Test tiers](/concepts/test-tiers/): why this is a separate tier rather
  than a slower unit test.
- [Assert what a run journaled](/guides/assert-a-journal/): the vocabulary for the
  evidence a resumed run leaves.
