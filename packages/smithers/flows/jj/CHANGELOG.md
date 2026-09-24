# @smthrs/jj

## [Unreleased]

### Changed

- **CONTRACT:** `Jj.snapshot` returns `{ commitId, changeId }`. Restore, diff,
  fork, and revert by `commitId`, the full hex commit id: no later rewrite of
  the change (an agent's `jj squash`, `describe`, or `abandon`) changes the tree
  it names. A change id moves with such a rewrite, so journaling it restored
  the step's edits instead of the pre-image. `changeId` is display only.
  Journal rows written earlier hold a reverse-hex change id; the alphabets are
  disjoint, so both forms still resolve and no migration runs.

## 1.0.0-rc.0

### Changed

- Browser WASI append opens preserve `O_CREAT|O_EXCL` through the backend's
  atomic `ax` or `ax+` flag, so a file created after the existence probe answers
  `EEXIST` instead of being opened.
- `BrowserJj` copies raw `ArrayBuffer` bytes even when they came from another
  JavaScript realm, so a caller cannot mutate the bytes between failed
  instantiation attempts. A view backed by `SharedArrayBuffer` is copied into
  unshared bytes; a direct `SharedArrayBuffer` remains outside the option type.
- **CONTRACT:** Every `JjErrorCause` string is schema-bounded by
  `causeMessageLimit`, including the ellipsis. `jjErrorCause` truncates `name`,
  `code`, and `message` to fit. The `JjError` constructor and journal decoder
  reject an over-length cause built without that supported projection.
- Browser WASI timestamp setters reinterpret imported `i64` nanosecond stamps as
  WASI `u64` values before converting them to seconds, so a timestamp with bit 63
  set is no longer a date before the epoch.
- `BrowserJj` excerpts a guest-reported error `command` before putting it on the
  journaled `JjError`, matching the bound already applied to guest messages. The
  excerpt and the recorded `jj` command each count their ellipsis against the
  ceiling they name, so neither exceeds it by a character.
- `resolveJjBinary` records the environment variable that supplied an override,
  so `describe()` names the variable it actually read. `overrideVariables` is
  that list, and it holds `SMITHERS_JJ_PATH` alone.

- `Jj`'s error channel is now honest about the capability kernel: every method
  fails with `JjFailure` (`JjError | Permission.PermissionError`), and
  `workspaceAdd` additionally with `PlatformError` because the guarded
  implementation canonicalizes its destination path first. `@smthrs/kernel`
  decorates _this_ tag rather than redeclaring the interface behind one of its
  own, so there is one `Jj` interface and one `Jj` tag. The new dependency,
  `@smthrs/capability`, is a leaf that depends on nothing but `effect`, so this
  package stays browser-bundleable.
- Added `isJjError`, so a caller can tell "jj said no" from "the capability
  kernel said no" without matching on `_tag` by hand.
- **The tag key and the error `_tag` were RENAMED during the import**, from
  `flows/host/Jj` and `flows/host/JjError` to `@smthrs/jj/Jj` and
  `@smthrs/jj/JjError`. Both are durable identity: step keys digest the resolved
  service set, and `JjError` round-trips through the journal, so a 0.x run
  recorded against the old strings does not replay against rc.0 and a recorded
  step key does not match. rc.0 never loads a 0.x run database, so nothing
  silently half-resumes. `packages/jj/test/index.test.ts` pins both strings.
- `JjError.cause` is a bounded projection (`JjErrorCause`: `name`, `code`, and a
  `message` capped at `causeMessageLimit`) rather than the live host failure.
  An `Error` serializes to `{}` because its `message` and `stack` are not
  enumerable, so the previous `unknown` cause arrived at the far side of a
  journal round-trip with the diagnosis gone, and an unbounded object could drag
  a whole command line into the record.
- Every `JjError` the Node and browser adapters produce now names its `module`,
  `method`, and the `command` that produced it. `@smthrs/kernel` reads `.method`,
  and a caller that wants to branch on which operation failed no longer has to
  parse the message.
- Error classification is anchored to jj's own sentences. A ref or a path merely
  containing the word `conflict` is no longer read as a conflicted repository,
  and `Path doesn't exist` is no longer read as a missing revision: `invalid_ref`
  is decided before `conflict`, and both match jj's phrasing rather than a bare
  substring.
- `SMITHERS_JJ_PATH` now names the binary the Node and Bun layers actually
  spawn. It was resolved and printed by `smithers doctor` while every operation
  ran whatever `PATH` produced. It is the only override the resolver reads:
  migrate a host still setting `FLOWS_JJ_PATH`, which is not an alias and is
  ignored, so the layer falls back to `PATH` instead of the requested file. A
  resolution that came from `PATH` is still spawned as the bare name `jj`, so a
  host spawner that hands the child a different `PATH` still decides for itself.
- Spawn failures that never produced a process stay in the typed channel.
  `node:child_process` throws rather than emitting an `error` event for most of
  them, so an argument carrying a NUL byte, or a working directory that is a
  file, escaped as an Effect defect. A working directory that is missing or is
  not a directory is now reported as such instead of as `not_installed`, which
  is what `spawn` reports it as.
- Both Node layers bound how much of a child's output they buffer, at 64 MiB
  per stream, counted in bytes as they arrive. The engine outlives any one
  invocation, so a jj that never stops printing was an unbounded buffer in a
  long-lived process; it is now killed and the operation fails with `unknown`.
  The direct runner and the spawner-routed runner apply the same ceiling and
  report it identically.
- Every `JjError` the Node adapter produces now carries a `command`, including
  the empty-revision refusals that happen before anything is spawned.
- The direct Node runner decodes child output with a streaming decoder, so a
  multibyte code point split across two chunks is no longer two replacement
  characters. `layerSpawner` already behaved this way, and the two layers are
  required to agree.
- `workspaceAdd` and `workspaceForget` pass the caller's name and path as
  `--name=` and after a `--` terminator, so a value that begins with `-` is the
  positional it is meant to be rather than a jj flag.
- `revert` reports the paths it undid byte for byte, and `root` strips only the
  terminal line ending, so a path with leading or trailing spaces is reported as
  it exists on disk.
- `root(from)` resolves a file to the directory that holds it, which the
  contract has always described as an accepted argument and which `spawn`
  rejected with a synchronous `ENOTDIR`.
- The browser layer's WASI shim confines symlinks to the preopened slice. Paths
  are now resolved component by component in namespace coordinates rather than
  handed to the backend with links intact: an absolute link target is re-rooted
  at the preopen instead of being read as host-absolute, a relative one is
  clamped against the link's own directory, intermediate components are resolved
  as well so a link naming a directory cannot smuggle the rest of a path out of
  the slice, and an existing file outside the slice reached through a link is
  not opened or stat'd.
- Every WASI `u64` offset, size, and directory cookie is range-checked before it
  narrows to a JavaScript number, so a value above `Number.MAX_SAFE_INTEGER` is
  refused instead of silently addressing a different byte.
- `BrowserJj.workspaceAdd` with a revision attempts to roll the lane back when
  the pin fails, and reports the failure against `workspaceAdd`. A rollback that
  also fails can leave the lane registered. `BrowserJj.root(from)` fails for a
  path outside its slice instead of answering for an unrelated tree.
- `BrowserJj.layerUnsupported` names the commands `NodeJj` would have run
  (`jj describe`, `jj restore`) rather than `jj commit` and `jj edit`, which this
  package never invokes.

### Added

- `BrowserJj.layer({ fs, wasm })`: a working browser implementation of the
  `Jj` service. jj-lib v0.44.0 (pinned at `vendor/jj`) is compiled to a
  `wasm32-wasip1` reactor module by the `crates/flows-jj` shim crate, and a
  hand-written WASI preview1 host shim in `src/browser/` routes its filesystem
  syscalls (plus `random_get` for change-id entropy and `clock_time_get` for
  timestamps) to the same synchronous virtual-FS slice `BrowserFileSystem`
  uses — ZenFS in production, `node:fs` in tests. All six contract operations
  work against jj's Simple backend; git interop is out of scope for rc.0. The
  wasm artifact ships at `wasm/flows_jj.wasm` and rebuilds via
  `pnpm run build:wasm`. `layerUnsupported` remains exported for hosts without
  a wasm module, and `not_installed` is now produced only on the TS side.
  Hosts own durability: call `fs.sync()` after operations (see README).
- `NodeJj.layerAt` and `NodeJj.layerSpawnerAt`, re-exported as `BunJj.layerAt`
  and `BunJj.layerSpawnerAt`, bind jj to one absolute repository root so a later
  change to `process.cwd()` cannot redirect snapshots, restores, or diffs into
  another checkout. A relative root is a wiring mistake and throws a `TypeError`
  at construction. A relative `workspaceAdd` path then resolves against the
  bound root, and `root(from)` is exempt from the binding by design.
- `@smthrs/jj/node/resolveJjBinary`: the resolution order `smithers doctor`
  reports on, and `shellQuote`, so the remediation it prints is safe to paste
  even when the operator's path contains a space or a semicolon. `describe()`
  now also reports an override variable that was set to a path nothing exists
  at, instead of silently reporting the jj that `PATH` produced.
- Package-owned documentation. `packages/jj/docs/` holds the prose, and
  `packages/jj/scripts/docs.mjs` generates `docs/pages/api/jj.mdx` from that
  prose plus the JSDoc of every entry point declared in `packages/jj/Package.ts`,
  so the published export tables cannot drift from `src/` again.
- Split the `Jj` contract, `JjError`, and the Node, Bun, and browser adapters
  out of `@smthrs/host` into their own package.
