---
title: "Test code that depends on Jj"
description: "Stub the Jj service with makeNoop and layerNoop, hand-write a partial implementation, and decide when a test needs a real jj binary instead."
sidebar:
  order: 6
---

`Jj` is a service, so a test that exercises code depending on it swaps the
layer rather than the code. The package ships the stubs for that, and the
default they choose is deliberate.

## Stub everything, then override what the test needs

```ts
import { layerNoop } from "@smthrs/jj"
import * as Effect from "effect/Effect"

const layer = layerNoop({
  snapshot: () => Effect.succeed({ commitId: "test-snapshot", changeId: "test-snapshot" })
})
```

`layerNoop(overrides)` provides `makeNoop(overrides)` as the `Jj` layer. Every
method not overridden fails with `JjError` `not_installed`, naming the method
that was called:

```text
not_installed: Jj.status: jj is not available on this host
```

The failing default is the point. A test that stubs only `snapshot` gets a
named failure the moment the code under test reaches `restore`, instead of a
silent success that hides a call the test never meant to allow.

Both optional operations are stubbed too, so reaching one gives you the named
failure rather than "undefined is not a function".

Use `makeNoop` directly when you want the service value instead of a layer, for
example to call a method in a unit test with no Effect context.

## Hand-write an implementation

`root` and `revert` are optional on the interface, so a double may define the
six required members and nothing else. Reach for this shape when the code under
test never calls `root` or `revert`, and you want the six it does call to
succeed quietly:

```ts
import { Jj, make } from "@smthrs/jj"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"

const stubJj = Layer.succeed(
  Jj,
  make({
    snapshot: () => Effect.succeed({ commitId: "stub-snapshot", changeId: "stub-snapshot" }),
    restore: () => Effect.void,
    diff: () => Effect.succeed(""),
    workspaceAdd: () => Effect.void,
    workspaceForget: () => Effect.void,
    status: () => Effect.succeed("")
  })
)
```

`make` brands the implementation as the service, so a new backend is checked
where it is written rather than where it is provided.

## Non-mutating capability checks

`"revert" in jj` is true for `makeNoop`, for `BrowserJj.make`, and for
`BrowserJj.layerUnsupported` alike, because every shipped layer defines both
optional members. Property presence does not establish support. Use host
configuration or non-mutating capability metadata maintained by the host to
decide whether to show an undo affordance in advance. The `Jj` interface has no
support-query method.

## Handle a requested revert

Run a revert only after the user requests undo. On Node and Bun it inserts an
inverse change before the working copy, so it must never serve as a support
probe. Handle `not_installed` around that requested operation:

```ts
import { isJjError, Jj } from "@smthrs/jj"
import * as Effect from "effect/Effect"

// Run this effect only in response to the user's undo request.
const revertRequestedChange = (changeId: string) =>
  Effect.gen(function*() {
    const jj = yield* Jj
    if (jj.revert === undefined) {
      return yield* Effect.logInfo("Undo is unavailable on this host")
    }
    return yield* jj.revert(changeId).pipe(
      Effect.catch((failure) =>
        isJjError(failure) && failure.code === "not_installed"
          ? Effect.logInfo("Undo is unavailable on this host")
          : Effect.fail(failure)
      )
    )
  })
```

The effect returns the revert result on success and `undefined` when undo is
unavailable. Other failures propagate. Test the unsupported path with
`layerNoop({})`, the successful path with a revert stub, and propagation with a
stub that fails with another error.

## When a test needs a real jj

Stubs cannot prove anything about jj itself: argv quoting, the vocabulary the
adapter classifies, whether a restore merges or replaces. Those need a real
binary and a throwaway repository:

```ts
import { execFileSync } from "node:child_process"
import { mkdtemp } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

const repository = await mkdtemp(join(tmpdir(), "jj-suite-"))
execFileSync("jj", ["git", "init", repository], { stdio: "ignore" })
```

Provide `NodeJj.layerAt(repository)` rather than `NodeJj.layer`, so the suite
cannot be redirected by another test's `process.chdir`.

Two habits from this package's own suite are worth copying:

- **Do not let the suite silently skip.** Guard on whether jj is installed, and
  on continuous integration turn the skip into a loud failure. A behavioral
  regression that merges because the only suite exercising the real contract
  no-opped is the failure mode this guards against.
- **Set `JJ_EDITOR` to a marker script**, not to `true`. `jj describe` without
  `-m` starts the editor and waits for it, and `true` hides that behind a
  program that exits immediately. A marker file makes "no jj this layer runs
  ever opened an editor" an assertion instead of a hang.

## Testing browser code

`BrowserJj` needs a synchronous filesystem, and `node:fs` behind a rooted
adapter satisfies the same structural slice ZenFS does. That is how this
package tests the wasm layer under Node, and it is why `WasiFs` names a shape
rather than importing a backend.

For a browser host that ships no wasm module, `BrowserJj.layerUnsupported` is
the layer to provide: every operation reports `not_installed` with the jj
command the CLI adapter would have run.

## Run the package's ABI conformance gate

From `packages/smithers/flows/jj`, run `pnpm exec vitest run --maxWorkers=1`.
The normal configuration requires the committed `wasm/flows_jj.wasm` before
collecting any selected tests, including a focused selection. A missing artifact
fails the command. A subprocess sentinel verifies that failure and proves the
same configuration succeeds after its fixture receives the artifact.

The generated real-WASM test checks zero-length allocation, repeated owned
allocate/call/free cycles, initialized byte prefixes, memory growth, explicit
allocation/growth rejection and successful operations after failures. It never
passes arbitrary pointers or mismatched sizes to `free`. Every operation uses
a temporary repository, and cleanup accounts for both buffers and host files.

From the repository root, run `node scripts/run-jj-abi-campaign.mjs` for the
parser-only Rust target, native ABI sequences and exact WASM corpus replay.
`SMITHERS_ABI_SEED`, `SMITHERS_ABI_CASES`, `SMITHERS_ABI_STEPS` and
`SMITHERS_ABI_ARTIFACT_DIR` control replay and retained evidence. The default
scheduled workload is 5,000 cases and 32 sequences. A local 2,000-case /
16-sequence run is bounded local evidence. The normal Rust and package suites
use 256 cases and four sequences.

`crates/flows-jj/ABI_CAMPAIGN.md` documents the reports, independent result
checks and separate scheduled AddressSanitizer tier. Native parser tests run
on stable Rust without changing the runtime dependencies. Instrumentation needs
its declared nightly toolchain; an uninstrumented pass does not certify it.
Developer runs with a separate configuration must report their reduced scope
and do not replace the supported package gate.

## Startup probes under machine load

The version and spawner contract tests run real fixture executables under
Effect's test clock. Host scheduling does not consume their simulated startup
budget. Timeout tests wait for an atomically published child PID before advancing
the clock. Readiness uses cancellable asynchronous reads of that PID file, so
native filesystem watchers are not a prerequisite. A FIFO holds the child without
sleeps.

The 500 ms regression observes the real child's cleanup signal: no `SIGKILL`
at 499 ms, then `SIGKILL` and the typed timeout error at 500 ms, with the child
reaped before retrying. A pending layer fiber alone cannot prove the timeout
is still pending because an expired probe may be awaiting child cleanup. The
same assertions must reject a 1 ms budget supplied through `StartupTimeoutMs`;
the negative control checks that exact assertion failure. The production
5000 ms startup deadline is unchanged.

The live repository-lock fixture supplies a 60-second startup budget through
`StartupTimeoutMs`, matching the existing test watchdog. Those cases assert lock
semantics; startup latency belongs to the version tests under the test clock.
A FIFO regression holds a real version child through 5200 simulated milliseconds,
then releases it and verifies the typed lock error instead of a startup timeout.

The package runs test files serially so its child processes and WASM workloads do
not compete with every other file in the recursive workspace gate. The existing
finite test watchdog still reports a stalled test.
