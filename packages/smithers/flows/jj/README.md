# @smthrs/jj

Release candidate scope, host requirements and compatibility review are defined in the [library support policy](https://github.com/smithersai/smithers/blob/main/RELEASE_SUPPORT.md).

This package declares `effect` as an exact `4.1.0` peer dependency. Install one
`effect` release at that version so all Smithers packages share one Effect
runtime.

**Documentation:** https://github.com/smithersai/smithers/tree/main/packages/smithers/flows/jj/docs

Jujutsu version control as a portable Effect host service. Nine operations
behind one service tag: snapshot the working copy, restore it, diff two
revisions, add and forget a workspace, read status, find the repository root,
revert one change, and restore a whole operation.

One program written against that service runs against the
[jj](https://jj-vcs.github.io) command line on Node and Bun, or against jj-lib
compiled to WebAssembly in a browser tab. Behind a service rather than an
ad-hoc `spawn`, the repository is explicit, failures are a closed set of seven
codes, and a test swaps the layer instead of the code.

## Install

```bash
npm install @smthrs/jj@next effect
```

The [installation page](https://github.com/smithersai/smithers/blob/main/packages/smithers/flows/jj/docs/installation.md) covers the
`effect` peer range and the wasm asset a browser layer needs.

`NodeJj` and `BunJj` spawn the `jj` executable, which this package does not
vendor. Install it once with `brew install jj` or
`cargo install --locked jj-cli`. With no usable jj, every operation fails with
the `not_installed` code and a message naming the fix, rather than throwing.

## Snapshot a working copy and put it back

```ts
import { Jj } from "@smthrs/jj"
import * as NodeJj from "@smthrs/jj/node/NodeJj"
import * as Effect from "effect/Effect"

const program = Effect.gen(function*() {
  const jj = yield* Jj

  // `snapshot` captures the working copy without closing a change; the
  // commit id names exactly that tree.
  const { commitId } = yield* jj.snapshot("before the risky step")

  // ... do the work a step would do ...

  const patch = yield* jj.diff(commitId, "@")
  yield* jj.restore(commitId)
  return patch
}).pipe(Effect.provide(NodeJj.layerAt("/srv/checkouts/main")))

Effect.runPromise(program)
```

On every backend, `snapshot(message)` captures the working copy without closing,
describing, or opening a change, so the user's log gains no commit per
snapshot. It returns `{ commitId, changeId, operationId }`: `commitId` is the
durable handle to store and restore, `changeId` is the display name and moves
with rewrites, and `operationId` is the jj operation that recorded the capture.
`opRestore(operationId)` runs `jj op restore`, which also undoes bookmark
moves, rebases, `describe`, and `abandon` made after it. The message is not
written to the repository.
`layerAt` binds jj to one absolute repository root, so a later change to
`process.cwd()` cannot redirect a restore into another checkout.

## Entry points

The root is platform-neutral and browser-bundleable: the contract, its error,
and the no-op layer only. Every implementation lives under an explicit subpath,
the way `effect` keeps `@effect/platform-node` out of `effect`, so importing the
contract never resolves a `node:` built-in.

| Import                            | Platform                                                    |
| --------------------------------- | ----------------------------------------------------------- |
| `@smthrs/jj`                      | Any. Contract only, and it bundles for the browser.         |
| `@smthrs/jj/node/NodeJj`          | Node, through `node:child_process`.                         |
| `@smthrs/jj/bun/BunJj`            | Bun, re-exporting the Node adapter.                         |
| `@smthrs/jj/node/resolveJjBinary` | Node. Which `jj` file this host spawns, and why.            |
| `@smthrs/jj/browser/BrowserJj`    | Browser. jj-lib compiled to wasm over a virtual filesystem. |
| `@smthrs/jj/browser/WasiPreview1` | Browser. The WASI preview 1 shim that module runs on.       |
| `@smthrs/jj/browser/WasiFs`       | Browser. The synchronous filesystem surface the shim needs. |

`NodeJj` and `BunJj` each ship four layers: `layer` and `layerAt` spawn their
own child, `layerSpawner` and `layerSpawnerAt` route the same commands through
Effect's `ChildProcessSpawner`, so a contained host contains jj too. All four
share one command vocabulary, one error classification, and one 64 MiB output
ceiling.

`SMITHERS_JJ_PATH` names the `jj` binary the Node and Bun layers spawn. An
override that names an existing file stays authoritative even when it cannot be
executed, so a broken explicit path is reported rather than a different binary
being quietly substituted.

Snapshot messages are opaque strings on both browser and CLI layers, including
empty strings, leading `-`, quotes, and newlines. Node and Bun never pass them
to jj; workspace names and paths use `--name=` and `--` so option-like values
are not interpreted as CLI flags.

Node and Bun require **jj 0.39.0 or newer**, pinned by the exported
`NodeJj.minimumVersion` constant. Building a CLI layer spawns nothing and never
fails, so a program that never calls `Jj` runs on a host without jj. The layer
selects the absolute host executable when it is built, and the first operation
awaits a `jj --version` probe through the same runner used for operations. The
probe does not require the repository directory. Bound layers can be built
before runtime storage creates that directory; operations still require a valid
working directory. A supported probe result is shared per absolute path and
runner for the process lifetime. Each host spawner has its own probe cache. A
failed probe is not remembered: after `chmod +x` or an in-place upgrade, the
next operation probes again. Restart the process after replacing an accepted
binary at the same path, or after installing jj where none was found. Operations
keep using the selected path even if the host or spawner PATH changes. An older
or unrecognized version fails the operation with
`JjError.code = "unsupported_version"` and the required minimum; a missing
binary fails it with `not_installed`. The four CLI layers have no error channel.

Node and Bun snapshots disable jj's default new-file size limit with
`--config snapshot.max-new-file-size=0`, so new artifacts larger than 1 MiB are
included. Any command that still warns `Refused to snapshot some files` fails
with `JjError.code = "snapshot_refused"`, even when jj exits successfully.

Every Node and Bun command also passes `--config signing.behavior=drop`,
`--config fsmonitor.backend=none`, and disables the signing backend programs.
A rewritten commit comes out unsigned. Anything running in the checkout can write
`.jj/`, and jj migrates a planted `.jj/repo/config.toml` into its secure
config once `.jj/repo/config-id` is gone, so a signing program or fsmonitor
backend named there would otherwise run with the host's privileges on the next
snapshot. `--config` outranks every config file.

A revision passed to `restore`, `diff`, `revert`, or `workspaceAdd` must be `@`,
`@-`, a hex commit id, or a reverse-hex change id; any other string fails
`invalid_ref` before jj is spawned. The Node and Bun layers look an id up as
`exactly(commit_id(id), 1)` or `exactly(change_id(id), 1)`, so a bookmark or
tag named after a recorded commit id cannot redirect a restore.

One invocation buffers at most **64 MiB of each output stream**, counted in
bytes as they arrive rather than in decoded characters. jj is not an attacker,
but the engine outlives any one command, so a child that never stops printing is
killed and the operation fails with `unknown` rather than filling a buffer
nobody will read. Both Node layers apply the same ceiling, since routing jj
through the host's spawner must not change what a caller observes.

Node and Bun operations hold workspace and shared-store permits, including
`status`, which can snapshot. Processes coordinate through `.jj/smithers.lock`
and the store's `smithers.lock`; `root(from)` fences the directory it actually
queries. The default 120-second deadline bounds acquisition of both fences only;
execution can outlast it after acquisition.
Cancellation releases both permits. A caller reclaims only a same-host lock
whose owner process has exited.

`NodeJj.withRepositoryMutation` lets host adoption share these permits, and
`NodeJj.layerRepositoryMutation` provides them as the root's `RepositoryMutation`
service for platform-neutral code such as `SandboxMerge.apply`;
`RepositoryMutationTimeoutMs` overrides its deadline. The protected effect must
not call another fenced operation on the same store. The root's
`isGitLockContention({ message })` identifies confirmed shared `index.lock`
acquisition failures and ref-lock contention without executing work. It excludes
private-index, permission and conflict errors. Durable actions own retry policy;
`SandboxMerge.Apply` releases these fences before its engine-owned retry wait.
No helper sleeps or removes Git's active lock.

## Failures are seven codes

Every operation fails with a `JjError` carrying a stable `code`, the `module`
and `method` that failed, the `command` that produced it, and a plain-data
`cause`. `not_installed` means no usable jj on this host, `conflict` that the
repository refused, `invalid_ref` that a revision does not resolve,
`snapshot_refused` that jj skipped files while capturing the working copy,
`stale_workspace` requires deliberate working-copy recovery after committing or backing up files, and
`unknown` everything else jj reported. Nothing escapes as an untyped throw, and
the codes survive a journal round trip, so a recorded run keeps its meaning.

Two of those codes also fail a CLI layer before it hands out `Jj` at all, so a
composition sees them from the layer rather than from a call: `not_installed`
when the version probe finds no usable binary, and `unsupported_version` when
the binary it found is older than `NodeJj.minimumVersion` or prints a version
this package cannot parse. `unsupported_version` never reaches an operation.

**Feature detection is by error code, never by property absence.** A backend
that cannot perform an operation keeps the method and answers `not_installed`,
so `"revert" in jj` tells a caller nothing and the code that comes back tells
it everything.

## In a browser tab

A tab cannot spawn `jj`. It can run jj-lib itself, compiled to `wasm32-wasip1`
and shipped in this package as `wasm/flows_jj.wasm`. The page owns the
filesystem mount and the wasm bytes, so both arrive as arguments and the
library never fetches.

```ts
import { Jj } from "@smthrs/jj"
import * as BrowserJj from "@smthrs/jj/browser/BrowserJj"
import { configureSingle, fs } from "@zenfs/core"
import { IndexedDB } from "@zenfs/dom"
import * as Effect from "effect/Effect"

await configureSingle({ backend: IndexedDB })
const wasm = await WebAssembly.compileStreaming(fetch(wasmUrl))

const program = Effect.gen(function*() {
  const jj = yield* Jj
  return yield* jj.snapshot("before the step")
}).pipe(Effect.provide(BrowserJj.layer({ fs, wasm, root: "/repo" })))
```

Eight of the nine operations work there, with real change ids and a real
operation log. `revert` reports `not_installed`. Snapshot captures the current
change without describing or closing it and includes `operationId`;
`opRestore` restores the repository view while preserving remote and Git state,
and refuses changes to other workspaces. The backend also diverges from the command line in ways worth
reading before you assume parity: repositories use jj's Simple backend with no
git interop, only `snapshot` creates a missing repository while `status`,
`diff`, and `restore` refuse one with `unknown` and write nothing, real
symlinks are rejected before snapshotting, and durability belongs to the mount
rather than to this layer. All of them are listed in
[Run jj in a browser tab](https://github.com/smithersai/smithers/blob/main/packages/smithers/flows/jj/docs/guides/run-jj-in-a-browser.md).

## More

- [Installation](https://github.com/smithersai/smithers/blob/main/packages/smithers/flows/jj/docs/installation.md)
- [Quickstart](https://github.com/smithersai/smithers/blob/main/packages/smithers/flows/jj/docs/quickstart.md)
- [API reference](https://github.com/smithersai/smithers/blob/main/packages/smithers/flows/jj/docs/api.md)
- [Troubleshooting](https://github.com/smithersai/smithers/blob/main/packages/smithers/flows/jj/docs/troubleshooting.md)
- [`@smthrs/kernel`](https://github.com/smithersai/smithers/blob/main/packages/smithers/flows/kernel/docs/api.md), which owns the
  closed host service list this contract is one slot of.

## License

The shipped Rust dependency inventory in `THIRD_PARTY_NOTICES.md` is generated
from the locked Cargo graph for `wasm32-wasip1`. After a dependency change, run
`node packages/smithers/flows/jj/scripts/generate-third-party-notices.mjs` from the repository root;
`--check` detects drift and runs in Rust CI. The template under `scripts/` keeps
the attribution prose and license text; new license groups require review.
MIT. See [LICENSE](./LICENSE).
