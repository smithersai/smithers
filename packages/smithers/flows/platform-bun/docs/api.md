---
title: "API reference"
description: "Every export of @smthrs/platform-bun: the BunHost layers and their refusal, the containment options, the implementation identities, the BunFileSystem escape hatch, BunRuntime, the durable flow runtime on Bun, and BunGarbageCollector for Microsandbox."
---

```ts
import { BunHost } from "@smthrs/platform-bun"
import * as Effect from "effect/Effect"
import * as ChildProcess from "effect/process/ChildProcess"
import { ChildProcessSpawner } from "effect/process/ChildProcessSpawner"

const program = Effect.gen(function*() {
  const spawner = yield* ChildProcessSpawner
  return yield* spawner.string(ChildProcess.make("printf", ["hello"]))
}).pipe(Effect.provide(BunHost.layer))
```

This barrel and `BunHost` import `@effect/platform-bun` at module load. It
and the Effect Node platform packages are bundled privately, built from
`effect@4.1.1`. `effect` is a required peer at exactly `4.1.1`.

:::warning
This entry point is Node-only in the browser-bundle sense: it falls back to the
`@effect/platform-node` adapters off Bun, so it resolves `node:fs` and the other
`node:` built-ins. It runs on Bun and on Node. What it does not do is bundle for
a browser; a page composes
[`@smthrs/platform-browser`](/api/platform-browser) instead.
:::

Every host bundle builds without jj. The `Jj` slot requires jj 0.39.0 or newer
and checks its executable on its first operation, which fails with `JjError`
`not_installed` or `unsupported_version` when jj is missing or older. The
contained bundles route that probe through their process spawner and retire its
ledger entry when it exits. Probe results are cached per resolved absolute
executable path and runner; contained spawners share a result only within the
same spawner instance.

## Entry points

| Import                               | Source                                                                                                                             | Platform  |
| ------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------- | --------- |
| `@smthrs/platform-bun`               | [src/index.ts](https://github.com/smithersai/smithers/blob/main/packages/smithers/flows/platform-bun/src/index.ts)                 | Bun, Node |
| `@smthrs/platform-bun/BunHost`       | [src/BunHost.ts](https://github.com/smithersai/smithers/blob/main/packages/smithers/flows/platform-bun/src/BunHost.ts)             | Bun, Node |
| `@smthrs/platform-bun/BunFileSystem` | [src/BunFileSystem.ts](https://github.com/smithersai/smithers/blob/main/packages/smithers/flows/platform-bun/src/BunFileSystem.ts) | Bun, Node |

The root entry point exports exactly four names: `BunHost` and `BunFileSystem`,
each the namespace of the module above, and [`BunRuntime`](#bunruntime) and
[`BunGarbageCollector`](#bungarbagecollector), which have no subpath of their own. `@smthrs/platform-bun/internal/*` and
`@smthrs/platform-bun/*/index` are blocked in the export map;
`@smthrs/platform-bun/package.json` is exported.

Supported runtimes are Bun >=1.4.0 and Node.js >=22.19.0.

## BunHost

The complete closed Host bundle: layers, root errors, models,
implementation identities, and platform module re-exports.

### Layers

| Export             | Signature                                                                                                                                        |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `layer`            | `Layer.Layer<BunHost \| (EffectDigest.Digest \| SecureRandom.SecureRandom)>`                                                                     |
| `layerAt`          | `(root: string) => Layer.Layer<BunHost \| (EffectDigest.Digest \| SecureRandom.SecureRandom)>`                                                   |
| `layerContained`   | `(options?: ContainedOptions) => Layer.Layer<BunHost \| (EffectDigest.Digest \| SecureRandom.SecureRandom), never, ProcessLedger>`               |
| `layerContainedAt` | `(root: string, options?: ContainedOptions) => Layer.Layer<BunHost \| (EffectDigest.Digest \| SecureRandom.SecureRandom), never, ProcessLedger>` |
| `layerHttpClient`  | `Layer.Layer<HttpClient>`                                                                                                                        |

`layer` provides all five Host services, including the runtime-independent
`Path`. `Jj` is bound to the process working directory.

`layerAt` is `layer` with `Jj` bound to `root` instead. `root` must be an
absolute path without NUL; see [BunHostError](#bunhosterror).

`layerContained` is `layer` with process containment turned on: every child is
spawned through `@smthrs/kernel`'s `ContainedSpawner` with
`ProcessReaper.layerSpawner`, including its native adapter and
`ProcessReaper.processLifecycle`. Each pipeline leg prepares a supervisor,
records its identity, and then activates the target with a
`SIGTERM`-then-`SIGKILL` deadline. The ledger retires a record only after
verified cleanup, and `@smthrs/platform-node`'s `ProcessReaper` sweeps the records a
crashed incarnation left behind while the layer is built. `Jj` is built over
that same spawner (`BunJj.layerSpawner`), so a `jj` a dead host left running is
a ledger record like any other. The `ProcessLedger` requirement is deliberate:
only the program knows whether it has a durable one.

On POSIX, `handle.pid` names the supervisor; `exitCode` and `isRunning`
describe the target. Natural target exit still cleans up children in its owned
group, including children holding output open. `detached: false` retains the
supervisor but opts out of group cleanup, signalling only the target. Use the
handle's `kill` rather than signalling its numeric pid yourself. Explicit
stopping while a grouped target is alive attempts a best-effort ancestry sweep
for escaped descendants; natural exit does not reclaim deliberately escaped
sessions. Failed cleanup fails scope close and retains its record. Ordinary
Bun runtimes are supported; compiled Bun applications are refused before
activation because they cannot launch the runtime supervisor.

`layerContainedAt` is `layerContained` with `Jj` bound to `root`
(`BunJj.layerSpawnerAt`). It refuses a root exactly as `layerAt` does.

`layerHttpClient` is the network slot every factory above installs, on its
own: `EgressHttpClient.layer(process.env)` from `@smthrs/platform-node`. A `3xx`
comes back with its `location` header intact and the second origin is never
contacted. Following a redirect is `@smthrs/kernel`'s guarded
`HttpClient.layer`, which rechecks the capability on every hop.

### BunHostError

```ts
class BunHostError extends Schema.TaggedError<BunHostError>()("@smthrs/platform-bun/BunHostError", {
  code: Schema.Literal("invalid_repository_root"),
  message: Schema.String
}) {
  readonly name: "BunHostError"
}

type BunHostErrorCode = "invalid_repository_root"
```

The refusal `layerAt` and `layerContainedAt` throw when `root` is not absolute,
the empty string included, or contains NUL. It is thrown rather than failed
because a factory runs while a program composes its layers, where there is no
fiber to fail into and a wrong root is a composition mistake, not a runtime
outcome. The check runs when the factory is called, before any layer exists.

It is this package's class rather than the `Jj` adapter's: a Bun caller
composed `BunHost` and should learn nothing about the adapter behind the `Jj`
slot from an error message. The message names the Bun factory that refused,
never `NodeJj`, and repeats at most 64 code points of the root before reporting
its true length, so a root taken from input cannot flood a log line. Branch on
`code`; the message is for a person.

### Models

| Export              | Type                                                                                  | Meaning                                                        |
| ------------------- | ------------------------------------------------------------------------------------- | -------------------------------------------------------------- |
| `BunHost`           | `FileSystem \| Path \| ChildProcessSpawner \| Jj \| HttpClient \| ProcessConfinement` | The Host services and native confinement this bundle provides. |
| `BunHostErrorCode`  | `"invalid_repository_root"`                                                           | The stable codes a factory refuses with.                       |
| `ContainedOptions`  | `ProcessReaper.SpawnerOptions & ProcessReaper.Options`                                | What a caller may configure about containment.                 |
| `implementationIds` | `Readonly<Record<HostServiceIds[number], string>>`                                    | The module behind each raw bundle Host slot.                   |

All four factories supply the shared native
[`ProcessConfinement.layer()`](/api/platform-node#processconfinement).
Guarded commands use the same OS confinement on Node and Bun.

`ContainedOptions` carries three fields:

| Field      | Meaning                                                                                                               |
| ---------- | --------------------------------------------------------------------------------------------------------------------- |
| `graceMs`  | Milliseconds between the `SIGTERM` that asks a child to stop and the `SIGKILL` that makes it. Default 2000.           |
| `ownerPid` | The pid the reaper must never signal a group for. Default `process.pid`.                                              |
| `system`   | The operating-system seam the reaper reads liveness and start times through. Default: chosen from `process.platform`. |

`platform` is deliberately not part of it. The factory uses the real
`process.platform`, so the native process-group behavior and recorded identity
agree. A caller cannot describe a Windows record for an owner that actually
leads a POSIX group. For a smaller Bun composition, use
`ProcessReaper.layerSpawner` with a ledger and an underlying runtime spawner.

Each factory reads its options when it is called and splits them into the
spawner half and the reaper half, so a field meant for one can never be read by
the other and mutating the object afterwards changes neither layer.

`implementationIds` names the raw bundle implementation behind each slot rather than the
specifier you import it through, which is why the filesystem entry is
`@smthrs/platform-node/AtomicFileSystem`. Contained factories replace the
process runner with `ProcessReaper.layerSpawner`; this static table does not
describe that substitution:

```ts
{
  "effect/FileSystem": "@smthrs/platform-node/AtomicFileSystem",
  "effect/Path": "@effect/platform-bun/BunPath",
  "effect/process/ChildProcessSpawner": "@effect/platform-bun/BunChildProcessSpawner",
  "@smthrs/jj/Jj": "@smthrs/jj/bun/BunJj",
  "effect/HttpClient": "@smthrs/platform-node/EgressHttpClient"
}
```

A key is the slot's stable identity in [`@smthrs/kernel`](/api/kernel)'s closed
list, which is not always the specifier the tag is imported from: the spawner
slot is `effect/process/ChildProcessSpawner` while its tag comes from
`effect/process/ChildProcessSpawner`. The keys are written as literals
rather than positions in that list, so reordering it cannot silently pair a slot
with another slot's implementation. Nothing digests the record yet:
[`@smthrs/plan`](/api/plan)'s step key carries a `layers` component these values
are meant to feed, but no planner derives it from a host bundle today, so
changing one invalidates no cached step.

### Re-exports

`BunHost` re-exports these modules so a program that should reach only part of
the host has one place to take it from:

| Export                   | What it is                                                                                                                                                                |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `AtomicFileSystem`       | `@smthrs/platform-node/AtomicFileSystem`, the filesystem implementation itself.                                                                                           |
| `BunChildProcessSpawner` | `@effect/platform-bun/BunChildProcessSpawner`.                                                                                                                            |
| `BunCrypto`              | `@effect/platform-bun/BunCrypto`, the [Effect Crypto service](https://github.com/Effect-TS/effect/blob/main/packages/platform/bun/src/BunCrypto.ts) layer.                |
| `BunFileSystem`          | This package's `BunFileSystem` module.                                                                                                                                    |
| `HostLiveness`           | `@smthrs/platform-node/HostLiveness`, the [host liveness probe](/api/platform-node#liveness-and-reaping).                                                                 |
| `ProcessReaper`          | `@smthrs/platform-node/ProcessReaper`, the [contained spawner](/api/platform-node#processreaperlayerspawner) and [orphan sweep](/api/platform-node#liveness-and-reaping). |

`AtomicFileSystem` is in the set for the same reason `NodeHost` re-exports it:
it owns the only configuration escape hatch the filesystem slot has, and a Bun
program whose helper is elsewhere must reach
`AtomicFileSystem.layerWith` without adding
[`@smthrs/platform-node`](/api/platform-node) as a second dependency.

`BunJj` is deliberately absent. It belongs to [`@smthrs/jj`](/api/jj) and is
imported from there, never re-exported here.

`@effect/platform-bun/BunHttpClient` is deliberately absent too: its `layer`
follows redirects to origins the capability kernel never authorized. Take the
network slot on its own from `layerHttpClient`.

## BunFileSystem

The filesystem slot on its own.

| Export      | Signature                                 | Meaning                                                                                        |
| ----------- | ----------------------------------------- | ---------------------------------------------------------------------------------------------- |
| `layer`     | `Layer<FileSystem>`                       | The filesystem slot, carrying the kernel's atomic host extension. Is `AtomicFileSystem.layer`. |
| `layerWith` | `(options: Options) => Layer<FileSystem>` | The same filesystem against an explicitly configured helper and byte limits.                   |
| `Options`   | `AtomicFileSystem.Options`                | The helper, concurrency ceiling, timeout, and byte limits `layerWith` accepts.                 |

`layer` is `@smthrs/platform-node`'s `AtomicFileSystem.layer`, the same value
behind `NodeHost`'s filesystem slot, by identity and not by resemblance. It
carries the kernel's atomic host extension, so under
[@smthrs/kernel](/api/kernel)'s `FileSystem.layer` a guarded path operation runs
descriptor-relative and no-follow instead of failing closed, and a symlink
swapped in after authorization cannot redirect it.

That extension executes its syscalls through the `smithers-jj-export` helper,
a host prerequisite. Windows is unsupported.

`layerWith` is the escape hatch for a host whose helper is outside the default
search; `SMITHERS_WORKSPACE_JJ_EXPORT_BINARY` does the same without code. `BunHost` re-exports the
same escape hatch as `AtomicFileSystem`, for parity with `NodeHost`.
`executable` is re-validated per request, because the file it names can be
replaced while the host runs; everything else is snapshotted when the layer is
built.

## BunRuntime

```ts
import { BunRuntime } from "@smthrs/platform-bun"
```

The durable flow runtime on Bun: `@smthrs/platform-node`'s
[`NativeRuntime`](../../platform-node/docs/api.md#nativeruntime) bound to Bun's
SQLite driver and `BunHost`. Its API is `NodeRuntime`'s: `storage`, `make`,
`layer`, `layerHost`, `signalExitCode`, `defaultShutdownTimeoutMs`,
`maximumShutdownTimeoutMs`, and the `Options` and `HostOptions` types. The
[`NodeRuntime` reference](../../platform-node/docs/api.md#noderuntime) describes
each one; invalid options throw `@smthrs/flows`' `Runtime.RuntimeConfigurationError`
with `BunRuntime` leading the message.

```ts
import { Interpreter } from "@smthrs/flows"
import { BunRuntime } from "@smthrs/platform-bun"

const host = BunRuntime.layerHost(
  { filename: ".flows/engine.db", workspaceRoot: ".", owner: { hostId: "bun-host" } },
  Interpreter.layer(Hello)
)
```

The Bun database driver loads when a database opens, not when the module loads,
because it imports `bun:sqlite`, which only Bun resolves. It opens `bun:sqlite`
itself, so a Bun program adds no `@effect/*` package for SQLite. A PostgreSQL
URL opens through the optional `@effect/sql-pg` instead.

## BunGarbageCollector

```ts
import { BunGarbageCollector } from "@smthrs/platform-bun"
```

Bun's full garbage collection, as the `MicrosandboxSandbox.GarbageCollector`
service `@smthrs/sandbox`'s Microsandbox provider gives finished command
handles back to the guest with.
[`MicrosandboxSandbox`](../../sandbox/docs/api.md#microsandboxsandbox) says
why a machine needs it.

| Export      | What it is                                                                                                  |
| ----------- | ----------------------------------------------------------------------------------------------------------- |
| `collector` | The process's one collector: `Bun.gc(true)`, a synchronous full collection. Off Bun it fails with a defect. |
| `layer`     | Provides `collector` as `MicrosandboxSandbox.GarbageCollector`.                                             |

Every provider in the process shares `collector`, so all their command starts
count toward the same collections.

## Two services the bundle does not wrap

There is no shell service, and no runtime detection either, because Bun's
spawner _is_ the Node one. Running a command is Effect's `ChildProcess` and
`ChildProcessSpawner`, and there is nothing for a detection branch to choose
between.

There is no HTTP service either. `BunHost` provides the shared `EgressHttpClient.layer(process.env)`, so the
runtime never walks to a second origin behind the capability kernel's back.
Following a redirect is [@smthrs/kernel](/api/kernel)'s guarded
`HttpClient.layer`, which rechecks the capability on every hop.

## Reading next

[@smthrs/kernel](/api/kernel) owns the closed list and decorates these same tags
with capability checks. [@smthrs/platform-node](/api/platform-node) and
[@smthrs/platform-browser](/api/platform-browser) are the sibling bundles.
[The Host surface on Bun](./concepts/host-surface.md) explains what each slot
buys, [Runtime parity with Node](./concepts/runtime-parity.md) explains how far
the two runtimes are interchangeable, and
[Troubleshooting](./troubleshooting.md) lists the failures these exports
produce.

## Native windows and loopback HTTP

`BunDesktop.layer` provides `BunDesktop.DesktopWindow`, with `resources`, `open(url)` and `chooseDirectory()`.
The optional peer `electrobun` 1.18.1 is loaded only when this layer is built. Native window operations require an initialized Electrobun process. `open` uses
CEF, restricts navigation to the supplied origin and disables view RPC. The caller owns the Effect scope, which
closes its windows. A cancelled directory chooser returns `null`; native failures return `DesktopUnavailable`,
without copying OS messages into diagnostics. The private `#electrobun` import separates the native declaration
port from Electrobun's source-only TypeScript distribution.

`BunServer.layer(port?)` provides the Effect HTTP server and its Bun support services on `127.0.0.1`. The default
port, zero, asks the OS to choose one. The server closes with the layer's scope. Its Bun adapter is loaded only when
the layer is built; ordinary package imports do not start a socket or load native FFI.

The VibeLang desktop app is a composition example in `apps/vibelang-desktop`. Its native Linux acceptance test
runs both exports under Xvfb and drives the real native folder chooser and the real OpenAI-compatible HTTP/SSE path.

### Crash-safe local edits

`BunFileSystem.replaceFileString(fs, path, before, after)` writes a private sibling file, syncs it through the
host, preserves the original mode, rechecks the expected original, then uses same-directory atomic rename.
An interrupted temporary write leaves the original intact. An already applied edit is an idempotent success;
a changed original fails with `FileChanged`. This is optimistic conflict detection, not a lock against another
process writing between the final comparison and rename. Supply the kernel's confined filesystem to retain
its descriptor-relative root identity and no-follow boundary. The function requires Path and SecureRandom.

### Electrobun compatibility boundary

`BunDesktop.layer` supports Bun 1.4 with the compatibility-marked Electrobun 1.18.1 API. Upstream 1.18.1 assumes
cstring callback arguments are pointers; Bun 1.4 supplies strings. This package ships the correction in
`patches/electrobun@1.18.1.patch`, including redacted callback diagnostics. Compatibility version 2 also replaces the native Linux opener's shell
fallback with an OS argument vector, a bounded wait and private child diagnostics. The workspace already applies it.
External applications apply the shipped patch before using this optional native layer:

```sh
pnpm patch electrobun@1.18.1 --edit-dir .electrobun-compat
patch --directory=.electrobun-compat --strip=1 < node_modules/@smthrs/platform-bun/patches/electrobun@1.18.1.patch
pnpm patch-commit .electrobun-compat
```

The layer checks the patch's exported compatibility marker and fails with `DesktopUnavailable` before creating
any window if it is absent. Installing the unmodified optional peer does not silently enable an unsupported
native capability. Other Bun host services do not load Electrobun. Remove this patch and marker requirement when
a tested upstream release provides equivalent callback decoding and private diagnostics.

The `native` Vitest project runs the wrapper under Node/V8 against real Electrobun APIs hosted in a separate process.
It is Linux-only and is collected only when `flock`, `Xvfb`, `bun`, `pnpm`, `curl`, `python3`, `xdg-open` and Playwright Chromium
are installed and the native desktop shared libraries can load. The `portable` project runs the other tests without building or starting a native fixture; run it on
its own with `pnpm test --run --project portable --coverage.enabled=false`. Missing native prerequisites are reported when loading the config.
The native evidence does not establish desktop support or native coverage on macOS or Windows. Coverage still includes
all package sources and retains its 100% thresholds; a portable-only run does not certify native wrapper coverage.
The required shared libraries include GTK 3, WebKitGTK 4.1, Ayatana appindicator, X11/XTest and CEF's NSS, GBM and ALSA dependencies; the system opener uses the
repository's Playwright Chromium as a real headless browser. The Bun compatibility worker does not start another
native fixture. `BunDesktop.layerWith` injects the foreign `NativeLoader` port; successful tests use actual windows,
GTK selection/cancellation and the OS browser opener. Faulty native dependencies cover typed failures. This measures
the Effect wrapper, not C++/CEF. The helper prerequisite for filesystem tests remains unchanged.
