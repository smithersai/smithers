# @smthrs/platform-browser

Release candidate scope, host requirements and compatibility review are defined in the [library support policy](https://github.com/smithersai/smithers/blob/main/RELEASE_SUPPORT.md).

This package declares `effect` as an exact `4.0.5` peer dependency. Install one
`effect` release at that version so all Smithers packages share one Effect
runtime.

**Documentation:** https://github.com/smithersai/smithers/tree/main/packages/smithers/flows/platform-browser/docs

Two Effect platform services a browser tab otherwise cannot have: `FileSystem`,
over a virtual filesystem the page mounts, and `ChildProcessSpawner`, over a
bash interpreter that runs inside the page. Code written against Effect's
service tags runs in a tab without changing a line.

It also hosts the durable flow engine in the browser. The engine runs in one
dedicated worker per origin, chosen with a Web Lock, and keeps its step record
in SQLite on the origin private file system, so a run that a closed tab or a
killed browser interrupts resumes at the step it was in.

Effect's own browser platform package covers HTTP, sockets, workers, key-value
storage, and crypto. It ships neither of these, because a tab has no `node:fs`
and cannot fork. A tab can serve both, given a virtual filesystem such as ZenFS
over IndexedDB and an in-page interpreter such as just-bash. This package is
that adapter pair. Neither backend is a dependency here: each arrives as a
function argument, so the page chooses what is mounted and your bundle carries
no vendor code this package picked for you.

## Install

```bash
npm install @smthrs/platform-browser@next effect
```

[Installation](docs/installation.md#install-the-package) covers the import
forms and the browser bundle gate.

`effect` is a peer dependency at exactly `4.0.5`. The services
these adapters implement live in Effect 4, so Effect 3 does not satisfy it, and
two copies of `effect` in one program are two sets of service tags.

The backends are yours to install and to wire together:

```bash
npm install @zenfs/core @zenfs/dom just-bash
```

## Example

```ts
import { BrowserServices } from "@smthrs/platform-browser"
import { configureSingle, fs } from "@zenfs/core"
import { IndexedDB } from "@zenfs/dom"
import * as Effect from "effect/Effect"
import * as FileSystem from "effect/FileSystem"
import * as ChildProcess from "effect/process/ChildProcess"
import { ChildProcessSpawner } from "effect/process/ChildProcessSpawner"
import { Bash } from "just-bash"

await configureSingle({ backend: IndexedDB })

// Two views of one volume: the interpreter's, and the promises API the adapter reads.
const layer = BrowserServices.layer({ bash: new Bash({ fs }), fs: fs.promises })

const program = Effect.gen(function*() {
  const fileSystem = yield* FileSystem.FileSystem
  const spawner = yield* ChildProcessSpawner

  yield* fileSystem.makeDirectory("/workspace", { recursive: true })
  yield* fileSystem.writeFileString("/workspace/notes.txt", "one\ntwo\nthree\n")

  return yield* spawner.string(
    ChildProcess.make("wc", ["-l", "notes.txt"], { cwd: "/workspace" })
  )
})

console.log(await Effect.runPromise(program.pipe(Effect.provide(layer), Effect.orDie)))
```

The program names nothing from this package. It asks for `FileSystem` and
`ChildProcessSpawner`, so the same code runs under `@smthrs/platform-node` or
`@smthrs/platform-bun` unchanged.

## Run durable flows in a tab

The worker every tab starts runs the engine when its tab leads:

```ts
// engine.worker.ts
import wasmUrl from "@journeyapps/wa-sqlite/dist/wa-sqlite.wasm?url"
import { BrowserRuntime } from "@smthrs/platform-browser"
import { Answer, registration } from "./flows.ts"

BrowserRuntime.run({
  name: "smithers",
  // Loaded only once this worker leads, and only into this worker's bundle.
  sqlite: {
    module: () => import("@journeyapps/wa-sqlite/dist/wa-sqlite.mjs"),
    wasm: () => fetch(wasmUrl).then((response) => response.arrayBuffer())
  },
  flows: [Answer],
  registerFlows: registration
})
```

The package never imports the SQLite build or the engine eagerly: the worker
hands over the build as lazy imports, and `BrowserRuntime` imports the engine
when a worker first builds one. A tab that imports the package's root loads
neither, and an app's tab bundle carries no wasm.

Every tab starts its worker and sends its requests to the leader:

```ts
import { BrowserEngine } from "@smthrs/platform-browser"
import * as Effect from "effect/Effect"
import { Answer } from "./flows.ts"

const layer = BrowserEngine.layer({
  name: "smithers",
  worker: () => new Worker(new URL("./engine.worker.ts", import.meta.url), { type: "module" })
})

const program = Effect.gen(function*() {
  const engine = yield* BrowserEngine.BrowserEngine
  yield* engine.start(Answer, { executionId: "answer-1", payload: { question: "why" } })
  return yield* engine.result(Answer, "answer-1")
}).pipe(Effect.provide(layer))
```

## Share one SQLite database between tabs

The leader's worker also opens the app's own database, `app.db`, beside the
engine's in the same OPFS pool, and runs every tab's statements on it. A tab
reaches it through `SharedSqlite`, whichever tab's worker leads. TanStack DB's
browser persistence takes it as its injected `{ execute, close }`, so the app
loads one SQLite build instead of a second store with its own worker:

```ts
import { SharedSqlite } from "@smthrs/platform-browser"
import { createBrowserWASQLitePersistence } from "@tanstack/browser-db-sqlite-persistence"

const persistence = createBrowserWASQLitePersistence({
  database: await SharedSqlite.open({ name: "smithers" })
})
```

A transaction a tab opens is that tab's alone until it ends; another tab's
statement waits. The leader rolls back the open transaction of a tab that
closes, and a transaction open when the leader's tab closes ends with it.

[Run durable flows in a browser tab](docs/guides/run-flows-in-a-tab.md) is the
full walkthrough.

## Modules

| Module                       | What it provides                                                                                                   |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `BrowserFileSystem`          | `make` and `layer` over a ZenFS-shaped promises API, plus the `ZenFsPromisesLike` slice that API has to satisfy.   |
| `BrowserChildProcessSpawner` | `make` and `layer` over a just-bash interpreter, plus the `JustBashLike` slice, whose one member is `exec`.        |
| `BrowserServices`            | `layer({ bash, fs })`: the spawner, the filesystem, and `Path`, mirroring `NodeServices.layer`.                    |
| `BrowserHost`                | `layer({ bash, fs, jj })`: the closed Host bundle, adding the wasm-backed `Jj` and Effect's fetch `HttpClient`.    |
| `BrowserRuntime`             | The durable engine in a dedicated worker: `run`, the worker entry, over `serve`, `layerHost` and `layer`.          |
| `BrowserEngine`              | `layer({ name, worker })`: a tab's `start`, `result`, `cancel`, `signal`, `events` and `runs`, sent to the leader. |
| `BrowserSqlite`              | `layerSqlite`: one wa-sqlite build and OPFS VFS per worker; `layer`: a `SqlClient` over one database file on it.   |
| `SharedSqlite`               | `layer({ name })` and `open({ name })`: a tab's `execute` on the app's own database, run by the leader.            |
| `WebLock`, `TabChannel`      | The Web Lock that elects the leader, taken with `steal` by a focused tab, and the `BroadcastChannel` tabs use.     |
| `StoragePersistence`         | `persist`: asks the browser for persistent storage, so it does not clear the engine's store.                       |
| `BrowserCache`               | `layer({ name?, maxEntryBytes? })`: `@smthrs/artifacts`' `ImmutableCache` over the origin's Cache Storage.         |
| `TerminalSocket`             | `connect(url, { onOutput })`: a page's socket to a terminal over `TerminalProtocol`; redials on a `RetryPolicy`.   |
| `BrowserLanguageServer`      | `make({ worker, workspace })` in a tab and `serve` in its worker: `@smthrs/std`'s `LanguageServer` on TypeScript.  |

Three properties are worth knowing before you compose them.

`bash`, `fs`, and `jj.fs` must be views of one mount. Nothing raises when they
are not, because each object is valid on its own; the command simply reads a
file the write never reached. The layer signatures make the pairing an explicit
decision at the one place a caller can still get it right.

`BrowserFileSystem.layer` is an assertion about `fs`. It carries
`@smthrs/kernel`'s whole-filesystem isolation attestation, which says the
promises object cannot name a path outside its own volume, and which lets the
guarded surface resolve paths directly. A mounted ZenFS volume satisfies that
when the workspace occupies the whole mount, so the layer refuses any
`workspaceRoot` other than `/`; a host-backed `node:fs/promises` does not.
`BrowserFileSystem.make` builds the same service with no such claim.

`BrowserHost`'s HTTP slot is Effect's fetch client configured with
`RequestInit { redirect: "manual" }`, so a redirect comes back to you and the
second origin is never contacted on its own. There is no Smithers wrapper around
`fetch`. `Crypto` is not one of the five Host tags, so a page that hashes
artifacts adds `BrowserCrypto.layer` from `@effect/platform-browser`.

## What a tab cannot do

Both adapters state their limits rather than faking them, so a program meets
each one as a typed failure at the call, not as a wrong answer later:

- **Output is buffered.** The interpreter runs to completion, so `stdout` and
  `stderr` each emit one chunk after it finishes and `all` is one then the
  other. A stdin `Stream` is rejected at spawn.
- **There is no process table.** `pid` is a per-layer counter, `killSignal` is
  ignored, `forceKillAfter` and piped commands are rejected, and interruption,
  timeouts, and `kill` abort the interpreter through its `AbortSignal` and are
  reported on the handle as a `PlatformError`.
- **One command runs at a time**, behind a permit held until the interpreter's
  promise settles, so two runs never mutate the mount at once.
- **A promises-shaped volume has no symlink creation, writable handles, or
  watcher**, so `chmod`, `chown`, `copy`, `copyFile`, `glob`, `link`, `symlink`,
  `readLink`, `open`, `sink`, `truncate`, `watch`, and the `makeTemp*` family
  fail with a `PermissionDenied` `PlatformError` naming the method.
  `rename` and `utimes` are served when the backend supplies them; otherwise
  they fail with the same refusal. `NotFound` is reserved for a path the backend
  reports absent. Copy by reading and writing, and append with
  `writeFile({ flag: "a" })`.
- **A tab has no working directory**, so `cwd` and a relative path given to
  `realPath` resolve against the volume root. Pass absolute virtual paths.
- **Durability belongs to the page.** ZenFS acknowledges a write before it
  reaches IndexedDB or OPFS, so call the mount's `sync()` after writes that must
  survive a reload.

What is served honours its options rather than dropping them: `makeDirectory`
forwards `mode`, `writeFile` forwards `flag` and `mode`, `access` answers from
the reported mode bits, `stream` honours its bounds and refuses fractional ones,
and `realPath` canonicalizes through the backend's own `realpath` when it has
one. Without `realpath`, `realPath` fails with a `PermissionDenied` `PlatformError`;
there is no fallback. The full statement is at https://github.com/smithersai/smithers/blob/main/packages/smithers/flows/platform-browser/docs/contract.md,
each option and backend error tag is tabled at
https://github.com/smithersai/smithers/blob/main/packages/smithers/flows/platform-browser/docs/api.md, and every refusal with its
fix is at https://github.com/smithersai/smithers/blob/main/packages/smithers/flows/platform-browser/docs/troubleshooting.md.

## Runtimes

Every entry point bundles for a browser, `BrowserHost` included: no published
module resolves a `node:` built-in, so no bundler asks for a polyfill it cannot
supply. The package ships as ESM and CommonJS with TypeScript declarations, and
its `engines` field asks for Node.js 26.4.0 or later, which is the toolchain
that installs and builds it rather than a runtime the code needs.

A tab runs the memory engine and the capability kernel over these adapters. The
durable engine runs in a dedicated worker, where OPFS offers the synchronous
access handles SQLite needs; a service worker does not offer them.

Because both backend slices are structural, a test satisfies them without either
vendor package: Node's own `node:fs/promises` satisfies `ZenFsPromisesLike`, and
`JustBashLike` is one function. See
https://github.com/smithersai/smithers/blob/main/packages/smithers/flows/platform-browser/docs/testing.md.

`BrowserRuntime.layerHost` and `run` accept `authorize(database)`, an Effect checked on every activation before the engine is constructed, any unfinished work resumes, or tabs read the shared database. Use it for device ownership checks that must never replay from a cached preparation. Failure ends activation and reports the stopped engine to its tab; it does not expose the database. The `database` a successful check was given stays usable while that activation serves, so the host can check again later, such as to record a new owner of the device without restarting the engine; each such statement commits on its own. `prepare` remains the durable, once-per-epoch schema upgrade after authorization.

Worker flow registrations may require the engine's `SqlClient` and
`DurableWriter` services, in addition to `BrowserRuntime.Host` and `FlowRuntime`.
For example, an injected durable memory source uses these services over the
engine's OPFS database; the application does not open a second database.

Interpreter failures expose a fixed process error description without the original exception or cause. Aborted process errors omit the command line and arguments.
