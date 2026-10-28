---
title: "Troubleshooting"
description: "The failures @smthrs/platform-browser reports: a split mount, writes lost on reload, the spawner's refused options, the operations a mounted volume cannot serve, a stalled interpreter, an opaque redirect returned with status 0, and the durable engine's refusals."
---

Find the symptom, read the cause, apply the fix. Every failure on this page is
one this package actually produces, and the signatures behind them are on the
[API reference](./api.md).

A `PlatformError` prints its parts, so the tag, the module, the method, the
path, and the description are all in the message a caller sees:

```text
PermissionDenied: FileSystem.access (/workspace/readonly.txt): the path does not carry the requested permission
```

## A command cannot see a file the filesystem just wrote

**Symptom.** `FileSystem.writeFileString` succeeds, and a command run right
after it reads nothing, or reports that the file is missing. Reading the same
path back through `FileSystem` returns the bytes.

**Cause.** The interpreter and the promises object are views of different
volumes. Nothing checks the pairing at run time, because nothing can: both
objects are valid, and they answer about different filesystems.

**Fix.** Take both views from one mount, in one place:

```ts
import { BrowserServices } from "@smthrs/platform-browser"
import { configureSingle, fs } from "@zenfs/core"
import { IndexedDB } from "@zenfs/dom"
import { Bash } from "just-bash"

await configureSingle({ backend: IndexedDB })

const bash = new Bash({ fs })
const layer = BrowserServices.layer({ bash, fs: fs.promises })
```

`BrowserHost.layer` adds a third view, `jj.fs`, which is the synchronous slice
of the same mount. See [Injected backends](./concepts/injected-backends.md), and
assert the pairing once in a test the way
[Testing](./testing.md) describes.

## Writes disappear when the page reloads

**Symptom.** Everything works inside one page load. After a reload the volume is
empty, or holds an older state than the last write returned.

**Cause.** ZenFS fronts IndexedDB and OPFS with a synchronous mirror and writes
back asynchronously. A returned write is a write to the mirror, not to storage.

**Fix.** Call the mount's `sync()` after the writes that must survive a reload,
including after jj operations. This package never syncs for you: the page owns
the mount, so only the page knows when a checkpoint is due.

## BadArgument: the working directory is not a directory

**Symptom.** A spawn fails before the interpreter runs:

```text
ChildProcess.spawn: the working directory /workspace/notes.txt is not a directory
```

**Cause.** The `cwd` on the command names an existing non-directory. The
adapter stats `cwd` and reports `BadArgument` from `ChildProcess.spawn` before
calling the interpreter. An absent path propagates `NotFound` from `FileSystem.stat`
instead.

**Fix.** Pass an absolute path to an existing directory inside the volume. A tab
has no `process.cwd()`, so a relative `cwd` resolves against the volume root
rather than against the ambient working directory a server would have.

## The spawner refuses an option instead of running the command

**Symptom.** A spawn fails with a `BadArgument` naming the input it will not
honour, and the interpreter is never called.

**Cause.** just-bash is a buffered, run-to-completion API with no process table.
Each of these inputs asks for something a tab cannot do, so the adapter refuses
it rather than dropping it silently:

| Message                                                                                         | Change                                                                         |
| ----------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| `just-bash has no process table to pipe between; express the pipeline as a single command line` | Write the pipeline as one command line and let the interpreter parse the pipe. |
| `this adapter runs the interpreter once with captured output and cannot stream stdin into it`   | Remove the `stdin` stream. Pass the input as a file or an argument.            |
| `just-bash cannot configure additional file descriptors`                                        | Remove `additionalFds`.                                                        |
| `just-bash cannot select the requested shell /bin/zsh`                                          | Use `shell: true`, which means the in-page interpreter, or drop the option.    |
| `just-bash cannot detach a command from the browser tab`                                        | Remove `detached: true`. Nothing outlives the tab.                             |
| `just-bash has no force-stop after the abort, so forceKillAfter cannot be honoured`             | Remove `forceKillAfter` from the command and from `kill(options)`.             |

**Fix.** Branch on `error.reason._tag === "BadArgument"` when the input comes
from somewhere you do not control, and see
[Run a command in a tab](./guides/run-a-command.md) for the full list, including
the two members that answer rather than refuse: `getInputFd` gives `Sink.drain`
and `getOutputFd` gives `Stream.empty`.

## Unknown: the interpreter run was aborted

**Symptom.** After a `kill`, a timeout, an interruption, or a scope closure,
`exitCode` and both output streams fail:

```text
Unknown: ChildProcess.kill (wc -l notes.txt): the interpreter run was aborted
```

**Cause.** This is the designed answer, not a defect. The handle's observables
are typed `Effect<_, PlatformError>`. Replaying the worker's interrupt through
them would cancel the caller's own fiber, which a caller cannot tell apart from
the whole run being cancelled by someone else, so the abort is reported as a
value in the error channel instead. The `pathOrDescriptor` is the command line
that was aborted.

**Fix.** `Effect.result(handle.exitCode)` returns a `Failure` with this
`PlatformError` in `failure`, or a `Success` with the exit code in `success`.
The abort is a typed failure; defects and fiber interruptions are not captured
by `Effect.result`.

## Unknown: a message from the interpreter, at ChildProcess.spawn

**Symptom.** A run fails with the interpreter's own message:

```text
Unknown: ChildProcess.spawn: no interpreter mounted
```

**Cause.** `exec` rejected, or threw before it returned a promise. Both are
failed runs rather than defects in this adapter, so both are wrapped as a system
`PlatformError` with the original kept as the `cause`.

**Fix.** Read `error.reason.cause` for the interpreter's own error. A throw
before the promise usually means the interpreter was constructed over a mount
that is not configured yet: call `configureSingle` before `new Bash({ fs })`.

## Every command after the first one hangs

**Symptom.** One command never settles, and every later command waits behind it
forever. `isRunning` stays `true`.

**Cause.** Runs are serialized behind a permit, and the permit is held until the
interpreter's promise settles rather than until the calling fiber stops waiting.
An interpreter that ignores its `AbortSignal` and never resolves therefore
blocks every later run. That is the honest outcome: releasing the permit early
would let a second interpreter run over a mount with a write still in flight.

**Fix.** `JustBashLike.exec` requires the returned promise to settle once
`signal` aborts, and rejecting with `signal.reason` is the expected answer. Fix
the interpreter or the stub standing in for it. The
[testing page](./testing.md) shows the stub shape that makes this observable.

## PermissionDenied: the browser backend does not support an operation

**Symptom.** A filesystem call fails without touching the volume, and the
message names the method:

```text
PermissionDenied: FileSystem.symlink (symlink): the browser backend does not support symlink
PermissionDenied: FileSystem.rename (rename): the browser backend does not support rename
PermissionDenied: FileSystem.realPath (/workspace/notes.txt): the browser backend does not support realPath
```

**Cause.** A promises-shaped volume has no symlink creation, writable handles, or
watcher, so those operations are refused rather than faked. `rename`, `utimes`,
and `realPath` are refused the same way when the backend omits `rename`,
`utimes`, or `realpath`. `realPath` has no lexical fallback, because lexical
normalization cannot prove where a symlink resolves. `NotFound` is reserved for
a path the backend reports absent, so this failure never means the path is
missing.

**Fix.** Reach for the served operation
[Read and write files on a mounted volume](./guides/work-with-files.md#what-fails-and-how)
names for each refusal. Supply `rename` and `utimes` for artifact publication,
and `realpath` for `realPath` and every guarded filesystem operation;
`@zenfs/core` and `node:fs/promises` provide all three.
[What the filesystem serves](./api.md#what-the-filesystem-serves) lists what is
served and what each option does.

## PermissionDenied: the workspace root is not the mount root

**Symptom.** Composing the layer fails before the program runs:

```text
PermissionDenied: FileSystem.layer (/repo): isolation requires the workspace root to equal the mount root /
```

**Cause.** `BrowserFileSystem.layer` was given a `workspaceRoot` other than `/`.
The isolation attestation holds only when the workspace occupies the whole
mount, so the layer refuses a narrower root rather than attesting it. See
[The isolation attestation](./concepts/isolation-attestation.md).

**Fix.** Mount a separate volume for each workspace and leave `workspaceRoot` at
`/`. To work in a repository directory inside the mount, set `jj.root`, which
does not narrow the isolation root.

## BadResource: a directory link loops, or the tree is nested too deep

**Symptom.** A recursive `readDirectory` fails partway through:

```text
BadResource: FileSystem.readDirectory (/workspace): a directory link loops, or the tree is nested more than 128 levels deep, and this backend has neither lstat nor realpath to tell them apart
```

**Cause.** The walk is done by this adapter, since the slice has no recursive
`readdir`. A backend with `lstat` lists a symlinked directory without descending
into it, and a backend with `realpath` closes a loop by identity. A backend with
neither follows the link and reports a fresh pathname at every level, so that
walk, and only that walk, is capped.

**Fix.** Supply `lstat`, `realpath`, or both. `@zenfs/core` and
`node:fs/promises` provide both, so this failure means the volume behind `fs` is
neither.

## BadArgument on a stream bound

**Symptom.** `stream` fails before the file is opened:

```text
FileSystem.stream: offset must be a whole, non-negative number of bytes
FileSystem.stream: chunkSize must be a whole number of bytes between 1 and 67108864
```

**Cause.** A bound that is not a byte count is refused rather than clamped: a
negative `offset` is not "the start", and a fractional `chunkSize` is not a
buffer length. The chunk ceiling is 64 MiB, because the chunk is a buffer this
adapter allocates on your behalf in the one heap the whole page shares.

**Fix.** Pass whole, non-negative counts for `offset` and `bytesToRead`, and a
`chunkSize` between 1 and 67108864. Leave `chunkSize` unset for the 64 KiB
default.

## BadArgument: invalid encoding

**Symptom.** `readFileString` fails on a file that reads fine as bytes:

```text
FileSystem.readFileString: invalid encoding
```

**Cause.** The encoding argument is passed straight to `TextDecoder`, and this
one is a label it does not know.

**Fix.** Pass a label from the Encoding Standard, or omit the argument for
UTF-8. Invalid byte sequences are a separate matter: they decode to the
replacement character, which is `TextDecoder`'s non-fatal default, rather than
failing.

## PermissionDenied on a path that exists

**Symptom.** `access` fails for a file you can `stat`:

```text
PermissionDenied: FileSystem.access (/workspace/readonly.txt): the path does not carry the requested permission
```

**Cause.** A mounted volume has no user identity to check a request against, so
the reported `mode` bits are the whole answer: a path is readable when any read
bit is set and writable when any write bit is set. That is stricter than
dropping the option, which would report a read-only file as writable.

**Fix.** Create the file with the mode you need. `makeDirectory({ mode })` and
`writeFile({ mode })` are both forwarded, so a directory asked for as `0o700` is
not created `0o755`.

## A redirect comes back with status 0 and no headers

**Symptom.** An `HttpClient` request to a URL that redirects returns a response
with status `0`, no headers, and no body, and the destination is never
contacted.

**Cause.** `BrowserHost` configures Effect's fetch client with
`redirect: "manual"`, so the host client never walks to a second origin behind
the capability kernel's grant check. Under the Fetch standard a manual redirect
in a tab is an opaque-redirect response, so there is no `location` header for
anything above to follow.

**Fix.** This is the browser failing closed, and it is the intended behaviour.
Request the final URL, or follow the hop through
[`@smthrs/kernel`](/api/kernel)'s guarded `HttpClient.layer`, which rechecks
every hop against the grant. The same bundle under Node or Bun sees the ordinary
3xx instead, so a test that reproduces this outside a browser sees a status and a
`location` rather than the opaque response. See
[The closed Host surface](./concepts/host-bundle.md).

## Every jj operation reports not_installed

**Symptom.** The `Jj` tag resolves, and every operation on it fails with
`not_installed`.

**Cause.** The composition installed `BrowserJj.layerUnsupported`, which is the
explicit choice a page makes when it has no `flows_jj.wasm` to hand over.
`BrowserHost.layer` never installs it on your behalf.

**Fix.** Compose `BrowserHost.layer({ bash, fs, jj })` with the compiled wasm
module, as in
[Compose the browser host bundle](./guides/compose-the-host.md). If the page
genuinely cannot serve the wasm, `not_installed` on every operation is the
stated outcome rather than a fault.

## Error: filesystem already carries a descriptor-relative executor

**Symptom.** Composition throws before the program runs:

```text
Error: filesystem already carries a descriptor-relative executor; attesting whole-filesystem isolation would replace it
```

**Cause.** `BrowserFileSystem.layer` applies
[`@smthrs/kernel`](/api/kernel)'s `withIsolatedFileSystem`, and the service it
was handed already carries the stronger, descriptor-relative guarantee. Applying
the attestation would replace it with a path-delegating one, so the kernel
refuses instead.

**Fix.** Compose one host filesystem. A browser composition provides
`BrowserFileSystem.layer` over the mount and nothing else; a native one provides
[`@smthrs/platform-node`](/api/platform-node) or
[`@smthrs/platform-bun`](/api/platform-bun).

## The spawner layer will not compose

**Symptom.** TypeScript reports `FileSystem` and `Path` as unmet requirements of
`BrowserChildProcessSpawner.layer(bash)`.

**Cause.** The spawner needs both for the same reason
`NodeChildProcessSpawner` does: `cwd` is stat'ed through `FileSystem` and
resolved through `Path` before the command runs.

**Fix.** Compose `BrowserServices.layer({ bash, fs })` or
`BrowserHost.layer({ bash, fs, jj })`, which provide both. To wire the spawner
alone, provide them yourself:

```ts
import { BrowserChildProcessSpawner, BrowserFileSystem } from "@smthrs/platform-browser"
import * as Layer from "effect/Layer"
import * as Path from "effect/Path"

const spawner = Layer.provide(
  BrowserChildProcessSpawner.layer(bash),
  Layer.mergeAll(BrowserFileSystem.layer(fs), Path.layer)
)
```

The `fs` behind that `BrowserFileSystem.layer` must be the mount the interpreter
runs on, or you are back at the first symptom on this page.

## A request to the durable engine never returns

**Symptom.** `BrowserEngine.start` or `result` waits forever, and no tab logs
`browser.runtime.leader`.

**Cause.** No worker leads. Either no tab built `BrowserEngine.layer`, so no
worker exists, or every worker's engine failed to build. A request waits for a
leader; it does not time out on its own.

**Fix.** Build `BrowserEngine.layer` when the tab opens. Read the worker's
`browser.runtime.stopped` line: its `error.type` names what failed, such as
`SqlError` for a store that would not open. A worker script that does not load
at all logs `browser.engine.worker` in the tab. Add `Effect.timeout` to a
request whose caller cannot wait.

## SqlError: Failed to open the OPFS directory

**Symptom.** The engine stops with this message right after a worker becomes
leader.

**Cause.** Something else holds the store's OPFS files. The pool waits about
five seconds for the previous leader's worker to release them; a context that
holds them longer is not that worker: a second engine with the same `name`
outside the app's lock, or a tab of another build of the app. The same message
appears when the store is opened outside a dedicated worker, which has no
`createSyncAccessHandle`.

**Fix.** Give every engine of one origin the same `name`, open the store only
through `BrowserRuntime.run` or `serve`, and close the tab of the other build.

## EngineUnavailable: worker-failed or engine-failed

**Symptom.** `start`, `result`, `cancel` or `signal` fails with
`EngineUnavailable`, and `browser.engine.unavailable` is logged.

**Cause.** This tab's engine worker failed. `worker-failed`: it threw, most
often while loading, as when a module it imports touches the DOM, which a
worker has none of; `error` names the error, or `ErrorEvent` when the browser
hides it. `engine-failed`: the worker loaded but could not build the engine,
as without OPFS; `error` is the failure's tag, the same `browser.runtime.stopped`
logs in the worker.

**Fix.** For `worker-failed`, open the worker's console: the load error is
there. For `engine-failed`, follow the `browser.runtime.stopped` entry for its
tag. `BrowserEngine.unavailable` reports the failure. A new leader
announcement restores requests; reload if no other tab can lead.

## SharedSqlite.open: No engine leader answered

**Symptom.** `SharedSqlite.open` rejects with a `SqlError` whose reason is a
`ConnectionError`, after `within` (30 seconds by default).

**Cause.** No worker leads the engine `name`: no tab started its engine worker,
the worker passed `BrowserRuntime.run` another `name`, or the leader could not
open OPFS and stopped (`browser.runtime.stopped`).

**Fix.** Start the tab's engine worker before opening the database, with the
same `name` on both sides. Without OPFS, fall back to memory, as
`@smthrs/effect-tanstack-db`'s `Persistence.layer` does when `open` rejects.

## SqlError: The transaction ended with the leader that held it

**Symptom.** A statement inside a transaction fails with a `ConnectionError`
right after another tab closed.

**Cause.** The closed tab's worker led, and the transaction lived on its
connection, which closed with it. The tab ran the transaction's statements
again on the new leader, and one of them returned other rows than it did the
first time, because another tab wrote in between. Carrying on would act on
reads that no longer hold, so the tab rolled the transaction back. A handover
in which every statement reads the same is invisible to the caller.

**Fix.** Treat it as any failed transaction: roll back, then run the whole
transaction again. TanStack DB's persistence doesn't: it stops the collection
with an error, so keep transactions short.

## RequestRefused: @smthrs/platform-browser/UnknownFlow

**Symptom.** `start` fails with `RequestRefused` whose `error` is
`@smthrs/platform-browser/UnknownFlow`.

**Cause.** The worker's `flows` does not list a flow with that tag.

**Fix.** Add the flow to `flows` and register its implementation in
`registerFlows`. A run of a flow the leader was not given is left as it is and
counted as `unknown-flow` in `smithers_browser_runtime_wakes`.

## RequestRefused with error SchemaError

**Symptom.** `start` fails with `RequestRefused` whose `error` is `SchemaError`,
though the payload matches the tab's flow.

**Cause.** The tab and the leader's worker declare the flow differently, so the
leader cannot decode what the tab encoded. A tab left open across a deploy runs
the old declaration while a newer tab's worker leads.

**Fix.** Reload the old tab. Change a flow's payload compatibly, or give the
changed flow a new tag.

## A step runs twice

**Symptom.** A step's side effect happens twice after a tab closed or the
browser crashed.

**Cause.** The worker died while the step ran, before its result was recorded,
so the next leader runs it again. A step whose result was recorded never runs
again.

**Fix.** Make a step's external effect idempotent, for example with a request
key the server deduplicates.

## Persistent storage is denied

**Symptom.** Tabs log `browser.engine.storage` with `outcome: denied`.

**Cause.** The browser decides. Chrome grants persistent storage to an
installed app or a site the person uses often, and denies it in a headless
browser; Firefox asks the person.

**Fix.** Install the app as a PWA. Without persistent storage the engine still
runs, but the browser may clear its store.

## The browser engine cannot open storage

`browser.sqlite.open` logs and spans identify the `stage`: `build` (JavaScript,
WASM and instantiation), `opfs` (the access-handle pool), `database` or `journal`.
Each records `opening`, then `ready`, `failed`, or `interrupted` on cancellation; `smithers_browser_sqlite_openings`
counts the same stage and outcome. A failed stage includes a bounded native
`error.type`, such as `SecurityError`, without its message, path or SQL. The
worker's `browser.runtime.stopped` and tab's `browser.engine.unavailable` record
the resulting engine failure. These records must reach the host's exporter.

An OPFS refusal in private browsing is different from a denied `persist()`
request: the engine cannot run. Open a regular browser window or reload after
restoring storage access. An app may keep editor text in memory, but must identify
that text as unretained and cannot claim that flow work survives a reload.

## `BrowserCache.layer` fails with `unavailable`

**Symptom.** Building the layer fails with `ImmutableCacheError`, operation
`open`, reason `unavailable`.

**Cause.** The context has no `caches` global, or the browser refused to open
the cache. Cache Storage exists only in a secure context, `https:` or
`localhost`, and `errorName` says why it was refused, such as `SecurityError`.

**Fix.** Serve the app over `https:`. Where no cache can exist, as in Node,
provide `ImmutableCache.layerMemory()` instead.
