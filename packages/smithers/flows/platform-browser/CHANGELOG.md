# @smthrs/platform-browser

## [Unreleased]

### Added

- The durable flow engine in the browser. `BrowserRuntime.run` is the entry of
  the dedicated worker each tab starts: the worker that holds the engine's Web
  Lock builds the engine over SQLite in OPFS, drives every unfinished run, and
  answers requests over a `BroadcastChannel`. When its tab closes, the next
  worker takes the lock and resumes the runs; a durable sleep that came due
  while no tab was open fires when the first tab opens. `BrowserRuntime.layer`
  and `layerHost` compose the engine as `NodeRuntime.layerHost` does.
- `BrowserEngine.layer`: a tab's `start`, `result`, `cancel`, `signal` and
  `events`, sent to whichever worker leads and sent again to the next one.
- `BrowserSqlite`: an Effect `SqlClient` over `@journeyapps/wa-sqlite`, opened on
  OPFS with the access-handle pool VFS. The build and its VFS are the injectable
  `Sqlite` service, so one worker opens one VFS for every store. A write's `.raw` reports `{ changes }`,
  and integers wider than 32 bits bind as SQLite integers.
- `WebLock`, `TabChannel` and `StoragePersistence`: the Web Locks API,
  `BroadcastChannel` and `navigator.storage.persist()` as injectable services.
- `SharedSqlite`: the app's own SQLite database, `app.db`, opened by the
  engine's leader beside `engine.db` on a connection of its own, and reached
  from every tab with `execute`. `SharedSqlite.open` is the `{ execute, close }`
  TanStack DB's browser persistence takes, so an app loads one SQLite build. A
  transaction is one tab's own until it ends, the leader rolls back the open
  transaction of a tab that closes, and `BrowserRuntime.statements` counts the
  statements by outcome. `Database.execute` rejects with `SqliteError`, whose
  `message` and `code` are SQLite's own, as wa-sqlite's `SQLiteError`: TanStack
  DB's persistence recognizes a column it already added by that message.
- `WebLock.hold(name, { steal: true })` takes a lock from whichever context
  holds it, so a focused tab can lead at once; the held lock's `lost` completes
  in the context it was stolen from. A leader whose engine lock is stolen stops
  leading and waits for the lock again.

- `BrowserEngine.EngineUnavailable` and `BrowserEngine.unavailable`: when the
  tab's own engine worker throws, as at load, or cannot build the engine, every
  pending and later request fails with `EngineUnavailable` instead of waiting
  forever, `unavailable` completes with why, and the tab logs
  `browser.engine.unavailable` and counts `smithers_browser_engine_unavailable`.
  `WorkerLike` now also takes `message` listeners, on which the worker reports
  an engine it could not build.

### Changed

- `BrowserRuntime.run` and `layerHost` take the SQLite build as lazy imports,
  `sqlite: { module, wasm }`, in place of the wasm bytes, and
  `BrowserSqlite.layerSqlite` takes `build` in place of `wasm`. The package no
  longer imports the SQLite build eagerly. The engine composition is imported
  statically to preserve Effect Schema identity and can be tree-shaken from a
  tab bundle; an app's tab bundle emits no wasm.
- The engine host's WebCrypto `Crypto` is `@smthrs/crypto`'s `WebCrypto.layer`,
  the one every host uses.

### Fixed

- Run-list reads use the shared retry schedule, cancel pending waits on recovery,
  reset the backoff after a successful read, and complete when the engine's scope
  closes. A new leader resumes its database preparation without reporting the
  built-in flow as unknown.
- Browser host documentation now describes sanitized interpreter failures,
  static engine imports, indefinite retries for held OPFS files, versioned
  preparation executions, and protected command arguments accurately.

- `PendingSnapshot.stage` returns a receipt unique to that staging. Staging a
  value equal to an earlier one no longer lets the earlier write's receipt remove
  the newer input.
- An app that compiles this package from source, such as one importing
  `BrowserRuntime` through a workspace link, type-checks: the package's
  `imports` field maps `#access-handle-pool-vfs` to `@journeyapps/wa-sqlite`'s
  `AccessHandlePoolVFS` and its types to the package's own declaration, so no
  consumer declares the module and no file needs a triple-slash reference.
- Two databases opened at once on one wa-sqlite build each get their own
  handle. wa-sqlite's `open_v2` returns the handle through one pointer shared
  by the build, so concurrent opens could both read the second handle and
  later fail closing it with `SQLITE_MISUSE`; opens on one build now run one at
  a time.

- `BrowserFileSystem` passes bytes and names across the backend boundary by
  value. `writeFile` copies `data` and reads `flag` and `mode` when it is
  called, so a buffer or options object the caller changes before the effect
  runs, or between retries, no longer changes what is written, and a backend
  that holds the buffer across its own commit cannot see the change either.
  `readFile` and `readDirectory` return a buffer and an array the caller owns,
  so a backend that answers from its own storage is neither corrupted through a
  result nor able to change one already returned. The copy is made with
  `new Uint8Array`, because Node's `Buffer` overrides `slice` to return a view.

## [1.0.0-rc.0] - 2026-09-01

### Added

- `BrowserFileSystem`: Effect's `FileSystem` over a ZenFS-shaped promises API,
  taken as a structural slice so no `@zenfs/core` dependency is introduced.
  `make` builds the service; `layer` provides it and carries `@smthrs/kernel`'s
  whole-filesystem isolation attestation, which says the volume behind the
  promises object cannot address any path outside itself.
- `BrowserChildProcessSpawner`: Effect's `ChildProcessSpawner` over a just-bash
  interpreter instance, taken as the same kind of structural slice. Runs are
  serialized, the command line is rendered with `@smthrs/kernel`'s
  `CommandLine.render` (the same string the `proc:spawn` grant is checked
  against), and every capability just-bash lacks is reported as a
  `PlatformError` rather than as silence: process pipelines, additional file
  descriptors, a custom shell path, a detached process, and a streaming stdin
  are all refused at spawn time. The `stdout`/`stderr` options keep their
  Node meaning, applied to captured text.
- `BrowserServices`: the aggregate layer mirroring `NodeServices`, providing
  `ChildProcessSpawner`, `FileSystem`, and `Path` from one call.
- `BrowserHost`: the complete closed five-tag Host bundle for a tab.
  `layer({ bash, fs, jj })` adds the wasm-backed `Jj` over the compiled
  `flows_jj.wasm` and the synchronous slice of the same mount, plus Effect's own
  `FetchHttpClient.layer` configured with `RequestInit { redirect: "manual" }`
  so the runtime never follows a redirect behind the capability kernel's grant
  check. A jj-less host composes `BrowserJj.layerUnsupported` explicitly; the
  bundle never installs it silently.

### Changed

- Interruption, `Effect.timeout`, scope closure, and `handle.kill()` now abort
  the interpreter through just-bash's `AbortSignal` instead of waiting for an
  uninterruptible boundary to finish. `isRunning` tracks the run rather than
  being `false` by the time a caller can observe it.
- The serialization permit is held until the interpreter promise itself
  settles, abort included, so a second interpreter cannot start on top of a
  call that is still writing to the mount. `JustBashLike.exec` now states the
  matching requirement: the returned promise must settle once the signal
  aborts.
- An aborted run is reported on the handle as a `PlatformError` naming the
  abort. `exitCode`, `stdout`, `stderr`, and `all` no longer replay the
  worker's interrupt, which silently cancelled the caller's own fiber.
- `JustBashLike.exec` options gained `signal` and `replaceEnv`. just-bash merges
  `env` into its own environment unless asked to replace it, so the adapter now
  asks for replacement whenever `env` is supplied and `extendEnv` is not `true`,
  which is Effect's own default.
- `forceKillAfter` is rejected on both routes that can carry it. Effect's
  `CommandOptions` extends `KillOptions`, so a command can name it without ever
  calling `kill`; `spawn` now refuses it up front the way `kill` does, rather
  than accepting a deadline this backend has no second, harder stop to honour.
  `killSignal` stays accepted and documented as meaningless for an interpreter
  that has no process to signal.
- `cwd` is validated as a directory rather than merely as an existing path, so a
  regular file is refused instead of being handed to the interpreter.
- `BrowserFileSystem` honours the options it used to drop: `readDirectory`
  walks the tree for `recursive`, `access` answers `readable` and `writable`
  from the reported mode bits, `makeDirectory` forwards `mode`, and `realPath`
  canonicalizes instead of returning its input, which is what makes
  `@smthrs/kernel`'s symlink boundary resolution real over a backend that
  supplies `realpath`. Without `realpath`, `realPath` fails with a `PermissionDenied`
  `PlatformError`. Canonicalization is left to that
  backend rather than being pre-empted: a `..` is no longer collapsed lexically
  before the link that precedes it is followed, so `link/..` names the parent of
  the link's target the way POSIX and `node:fs/promises` name it.
- `exists` reports `false` only for a path that is absent; every other backend
  failure now propagates, matching effect's own derivation.
- Backend errors map onto the `PlatformError` tag that carries their meaning:
  `EACCES` and `EPERM` become `PermissionDenied`, `EISDIR`, `ENOTDIR`, and
  `ELOOP` become `BadResource`, and `EBUSY` becomes `Busy`, alongside the
  existing `ENOENT` and `EEXIST` mappings.
- `stream` refuses an `offset`, `bytesToRead`, or `chunkSize` that is not a
  whole byte count instead of clamping it, caps a single chunk allocation at
  64 MiB, and refuses a backend that reports reading more bytes than the buffer
  it was handed.
- `ZenFsPromisesLike` gained optional `lstat` and `realpath` members, used for
  recursive listing and canonicalization when the backend provides them.
- `BrowserChildProcessSpawner.make` is public, matching `BrowserFileSystem.make`.
