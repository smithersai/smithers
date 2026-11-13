# @smthrs/platform-node

Release candidate scope, host requirements and compatibility review are defined in the [library support policy](https://github.com/smithersai/smithers/blob/main/RELEASE_SUPPORT.md).

**Documentation:** https://github.com/smithersai/smithers/tree/main/packages/smithers/flows/platform-node/docs

The Node.js Host bundle for Smithers. One layer, `NodeHost.layer`, provides the
five services a program runs its side effects through: a filesystem, a path
helper, a child-process spawner, a [Jujutsu](https://jj-vcs.github.io/jj/)
adapter, and an HTTP client.

`@effect/platform-node` already ships Node implementations of most of those, and
this package uses them where they fit. For a Node program that needs only file
and path access, compose `NodeHost.NodeFileSystem.layer` and
`NodeHost.NodePath.layer`. Three guarantees are not ones a
general-purpose adapter makes, so this package implements them itself:

- **A filesystem a symlink cannot redirect.** `AtomicFileSystem` opens the
  workspace root once, walks each component with `O_NOFOLLOW`, and performs the
  final syscall relative to a pinned directory descriptor, so a path swapped
  between the permission check and the operation cannot redirect it.
- **Child processes a crashed host does not leave behind.**
  `NodeHost.layerContained` gives every child a `SIGTERM`-then-`SIGKILL`
  deadline and a durable ledger record, and sweeps the records a previous
  incarnation abandoned while the layer is built.
- **An honest answer about whether a run's owner is still alive.**
  `HostLiveness.isAlive` is the probe a durable engine consults before it takes
  a run some other process recorded itself as owning. Ambiguity resolves toward
  alive, because stranding a run is cheaper than running it twice.

It is also where durable flows run on Node. `NodeRuntime.layerHost` stands the
`@smthrs/flows` engine up over SQLite or PostgreSQL on this host, guards flow
bodies behind the capability kernel, and shuts down cleanly on a signal.
`SandboxedFlow` runs a child flow's own code on a machine you provision.

It also hosts the Node pieces of [`@smthrs/std`](https://github.com/smithersai/smithers/tree/main/packages/smithers/agent/std/docs),
whose root entry is platform-neutral. `NodeLanguageServer` binds std's
`LanguageServer` to language-server processes on the host, and
`EgressHttpClient.layer` provides the system name resolver std's web tools
check every destination with, beside the client that pins each request to the
checked addresses.

## Install

```bash
npm install @smthrs/platform-node@next effect
```

The package installs `@smthrs/flows`, the Node SQLite driver
`@effect/sql-sqlite-node`, and `esbuild`, which `SandboxedFlow` uses to bundle a
guest entry module. A program that imports `@smthrs/flows` directly names it on
the install line too, because pnpm links only declared packages.

The [installation page](https://github.com/smithersai/smithers/blob/main/packages/smithers/flows/platform-node/docs/installation.md)
covers the `effect` peer range and the host requirements.

On POSIX, filesystem confinement requires Node.js 22.19.0 or later and the
`smithers-jj-export` native helper. The package ships the helper prebuilt for
macOS (arm64, x64), Linux (arm64, x64), and Windows (x64), so installing the
package installs it. `SMITHERS_WORKSPACE_JJ_EXPORT_BINARY` only overrides the
packaged helper with another absolute path. A missing helper refuses confined
operations, including MCP flow discovery.

## Run a command through the host

```ts
import { NodeHost } from "@smthrs/platform-node"
import { Effect } from "effect"
import * as ChildProcess from "effect/process/ChildProcess"
import { ChildProcessSpawner } from "effect/process/ChildProcessSpawner"

const program = Effect.gen(function*() {
  const spawner = yield* ChildProcessSpawner
  return yield* spawner.string(ChildProcess.make("git", ["status", "--short"]))
})

Effect.runPromise(Effect.provide(program, NodeHost.layer))
```

`ChildProcess` and `ChildProcessSpawner` are Effect's own tags. The same layer
also provided the `FileSystem`, `Path`, `Jj`, and `HttpClient` that program did
not ask for.

## Layers

| Layer                              | What it adds                                                      |
| ---------------------------------- | ----------------------------------------------------------------- |
| `NodeHost.layer`                   | the five tags, with `Jj` bound to the process working directory   |
| `NodeHost.layerAt(root)`           | the same, with `Jj` pinned to one absolute repository root        |
| `NodeHost.layerContained(options)` | process containment: kill deadlines, ledger records, a reap sweep |
| `NodeHost.layerContainedAt(...)`   | both, which is what the flow engine's `NodeRuntime` composes      |

The contained layers require a `ProcessLedger`, because the durable half of
containment is only as good as the journal underneath it. `ProcessLedger.layer`
inherits a crashed incarnation's processes; `ProcessLedger.layerMemory` contains
this one and nothing more.

```ts
import { ProcessLedger } from "@smthrs/kernel"
import { NodeHost } from "@smthrs/platform-node"
import { Layer } from "effect"

const host = Layer.provide(
  NodeHost.layerContained({ graceMs: 2000 }),
  ProcessLedger.layer({ hostId: "engine-1", ownerPid: process.pid })
)
```

The contained spawner prepares a supervisor and records its identity before
activating the target. On POSIX `handle.pid` names that owner, while
`exitCode` and `isRunning` describe the target. Natural target exit still
cleans up its owned group, including children holding output open. Use the
handle's `kill` for signal delivery; cleanup failure retains the ledger record.
`ScopedProcess` supplies this lifetime policy for transient commands without a
durable ledger, and exposes the separate native `Handle.targetPid` for diagnostics.

Complete host bundles build without jj. The first `Jj` operation probes the binary through its selected runner and fails with `JjError` (`not_installed` or `unsupported_version`) when jj 0.39.0 or newer is missing; a contained host records and retires this probe in its process ledger. Repository commands use the same runner.

## Modules

The barrel exports fourteen namespaces: `NodeHost`, `EgressHttpClient`,
`FetchTransport`, `NodeLanguageServer`, `HostLiveness`, `NodeGarbageCollector`,
`ProcessReaper`, `ScopedProcess`, `ProcessConfinement`, `ProcessSandbox`, and
the flow runtime: `NodeRuntime`, `NativeRuntime`, `SandboxedFlow`, and
`TestNodeRuntime`. `FetchTransport`, `NodeLanguageServer`,
`NodeGarbageCollector`, and the runtime modules have no subpath; import them
from the root. `AtomicFileSystem` is deliberately not among them; it is reached
as `NodeHost.AtomicFileSystem` or through the
`@smthrs/platform-node/AtomicFileSystem` subpath.

| Module               | What it provides                                                                                                                                                                                                                                                                                                                                                       |
| -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `NodeHost`           | the complete closed Host bundle, plus re-exports of `AtomicFileSystem`, `ProcessReaper`, `NodeCrypto`, and Effect's raw `NodeFileSystem`, spawner, and `HttpClient`                                                                                                                                                                                                    |
| `AtomicFileSystem`   | the descriptor-relative, no-follow filesystem layer and its options, ceilings, and glob grammar                                                                                                                                                                                                                                                                        |
| `HostLiveness`       | whether a recorded run owner is still alive: `isAlive`, `Owner`, `Options`                                                                                                                                                                                                                                                                                             |
| `ProcessReaper`      | live containment and restart reconciliation: `layerSpawner`, `SpawnerOptions`, `processLifecycle`, `reap`, `layer`, `System`, `Refusal`, `posixSystem`, `windowsSystem`, `systemFor`                                                                                                                                                                                   |
| `ScopedProcess`      | transient scoped commands with the same lifecycle: `Options`, `Handle`, `spawn`, `Status`, `status`                                                                                                                                                                                                                                                                    |
| `FetchTransport`     | how far each `fetch` to one origin got on the wire, read from Node's `undici` channels: `observe`, `Observer`, `Attempt`, `Phase`, `Fields`                                                                                                                                                                                                                            |
| `EgressHttpClient`   | the outbound HTTP client read off the environment's proxy variables, which pins web requests, and the system name resolver it provides as `@smthrs/kernel`'s `HttpClient.ResolveHost`: `layer`, `resolveHost`, `dispatcher`, `providerFetch` (an HTTP/1.1 `fetch` for a model host's provider calls), `rebuildableTransport`, `guardedTransport`, `EgressAddressError` |
| `NodeLanguageServer` | `@smthrs/std`'s `LanguageServer` over host language-server processes, routed by extension: `Config`, `MAX_QUEUED_FRAMES`, `MAX_PENDING_REQUESTS`, `make`, `makeLazy`, `layer`, `layerLazy`                                                                                                                                                                             |
| `NodeRuntime`        | the durable flow runtime on Node: `layerHost`, `layer`, `make`, `storage`, `signalExitCode`, `Options`, `HostOptions`                                                                                                                                                                                                                                                  |
| `NativeRuntime`      | the native lifecycle `NodeRuntime` and `@smthrs/platform-bun`'s `BunRuntime` bind: `make`, `Platform`, `Options`, `HostOptions`, `Api`                                                                                                                                                                                                                                 |
| `SandboxedFlow`      | a child flow's own code run on a provisioned machine: `execute`, `action`, `toLayer`, `SandboxedFlowError`, `Limits`                                                                                                                                                                                                                                                   |
| `TestNodeRuntime`    | test support, a durable engine over one SQLite file: `durableEngine`, `requirements`, `stubJj`                                                                                                                                                                                                                                                                         |

`NodeCrypto` is re-exported for a different reason than the rest: `Crypto` is not
a Host service, so it is not in the closed list, but every durable composition
needs one and a program that already depends on this package for its host should
not need a second dependency for the digest.

## What the bundle does not provide

**There is no shell service.** Running a command is Effect's `ChildProcess` and
`ChildProcessSpawner`, so a wall-clock budget is `Effect.timeout` around the
effect and cancellation is fiber interruption, not an `AbortSignal`.

**There is no HTTP service.** An outgoing request is Effect's `HttpClient`,
provided here as `EgressHttpClient.layer(process.env)`. It honors the egress
proxy named by `HTTP_PROXY`, `HTTPS_PROXY`, and `NO_PROXY`, using a direct
Undici pool when none is configured. Undici installs no redirect interceptor,
so every hop stays a separate, checkable request.

Both are what lets [`@smthrs/kernel`](https://github.com/smithersai/smithers/tree/main/packages/smithers/flows/kernel/docs) check
`proc:spawn` against the rendered command line before any process starts, and
`net:get` / `net:post` against the host of every URL a request reaches,
redirect targets included. Wrap the bundle in its `HostServices.layer` to get
that permission-aware projection.

## Where this sits

[`@smthrs/flows`](https://github.com/smithersai/smithers/tree/main/packages/smithers/flows/docs) is the durable flow engine: flows,
actions, the journal, and the runtime that replays a crashed run from where it
stopped. It deliberately re-exports no `@smthrs/platform-*` package, for the
same reason `effect`'s own index does not re-export `@effect/platform-node`:
the program that runs picks its platform. So a Node program installs
`@smthrs/flows` for the engine and this package for the machine underneath it.
This package's `NodeRuntime` composes the engine's `Runtime` over
`NodeHost.layerContainedAt` and `HostLiveness.isAlive` from one options object.

## Read next

The documentation site covers the rest: [the host bundle](https://github.com/smithersai/smithers/blob/main/packages/smithers/flows/platform-node/docs/concepts/host-bundle.md), [the descriptor-relative filesystem](https://github.com/smithersai/smithers/blob/main/packages/smithers/flows/platform-node/docs/concepts/descriptor-relative-filesystem.md)
and everything it refuses, [process containment](https://github.com/smithersai/smithers/blob/main/packages/smithers/flows/platform-node/docs/concepts/process-containment.md)
and every guard checked before a reap, the [API reference](https://github.com/smithersai/smithers/blob/main/packages/smithers/flows/platform-node/docs/api.md), and
[troubleshooting](https://github.com/smithersai/smithers/blob/main/packages/smithers/flows/platform-node/docs/troubleshooting.md).

For a different runtime, the sibling bundles are
[`@smthrs/platform-bun`](https://github.com/smithersai/smithers/tree/main/packages/smithers/flows/platform-bun/docs) and
[`@smthrs/platform-browser`](https://github.com/smithersai/smithers/tree/main/packages/smithers/flows/platform-browser/docs).

The host exports `implementationIds` for its five service slots. Its rooted
factories reject invalid roots before constructing a layer, using the host's
own error with code `invalid_repository_root`.

The atomic filesystem supports descriptor-based `chmod` and `chown` on regular files so replacements can preserve permissions and ownership. Symlinks, hard-linked files, directories, and special files are refused by this boundary.
