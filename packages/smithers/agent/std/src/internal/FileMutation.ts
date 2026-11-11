/**
 * Mutation preparation for versioned and batched hosts, and cooperative locks
 * for ordinary hosts. Ordinary locks fail closed after process death; they are
 * never stolen on a timer.
 *
 * @since 1.0.0
 */

import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import type * as FileSystem from "effect/FileSystem"
import type * as Path from "effect/Path"
import type * as PlatformError from "effect/PlatformError"
import type * as Result from "effect/Result"
import type * as Scope from "effect/Scope"
import * as Semaphore from "effect/Semaphore"
import * as StdError from "../StdError.ts"
import * as FsFailure from "./FsFailure.ts"

/**
 * Authenticated standard-flow call session; absent callers cannot borrow another run's base.
 *
 * @category context
 * @since 1.0.0
 */
export const ReadSession = Context.Reference<string | undefined>("@smthrs/std/ReadSession", {
  defaultValue: () => undefined
})

/**
 * The coding host attaches one run-scoped precondition policy to its guarded filesystem.
 *
 * @category identifiers
 * @since 1.0.0
 */
export const Preconditions = Symbol.for("@smthrs/std/file-preconditions")

/**
 * One prepared file change; moves include a write and a guarded source removal.
 *
 * @category models
 * @since 1.0.0
 */
export interface Change {
  readonly path: string
  /** Null removes a file. Writes preserve existing metadata; new files use host defaults. */
  readonly content: Uint8Array | null
  /** A move's source: a new destination takes its mode and owner. Versioned providers may ignore it. */
  readonly metadataFrom?: string | undefined
}

/**
 * A per-invocation provider receipt boundary, with immutable captured read bases.
 *
 * @category models
 * @since 1.0.0
 */
export interface Prepared {
  /** Return bytes matching the captured base, never an unchecked current read. */
  readonly read: (path: string) => Effect.Effect<Uint8Array, StdError.StdError>
  readonly commit: (changes: ReadonlyArray<Change>) => Effect.Effect<void, StdError.StdError>
}

/**
 * Read records only successful model-facing reads; mutation-internal reads never refresh a base.
 *
 * @category models
 * @since 1.0.0
 */
export interface VersionedFileSystem extends FileSystem.FileSystem {
  readonly [Preconditions]?: {
    readonly record: (
      path: string,
      bytes: Uint8Array,
      session: string | undefined
    ) => Effect.Effect<void, StdError.StdError>
    readonly validate: (
      paths: ReadonlyArray<string>,
      session: string | undefined
    ) => Effect.Effect<void, StdError.StdError>
    /** Capture this invocation's bases from the existing ledger before tool-internal
     * reads. The returned commit must compare them again inside the provider, then
     * settle the entire batch before advancing the ledger. Concurrent reads or
     * commits must never replace these captured bases. Preparation does not freeze
     * callers; only the complete commit may acquire guest-wide exclusion.
     */
    readonly prepare?: (
      paths: ReadonlyArray<string>,
      session: string | undefined
    ) => Effect.Effect<Prepared, StdError.StdError>
  }
}

/**
 * A filesystem whose every call is a network round trip, such as a
 * container's reached through `docker exec`, offers under this key the
 * batched calls the standard flows use instead of their usual sequences: one
 * `snapshot` before a change, one `commit` to make it, one `list` for `ls`.
 * Like {@link Preconditions}, it is a wire contract, so a provider need not
 * import this package. A provider should attach it non-enumerably, so a
 * wrapper that spreads the filesystem to guard its operations does not
 * inherit calls that route around the guards. A versioned host's provider
 * always takes precedence over it.
 *
 * @category identifiers
 * @since 1.0.0-rc.17
 */
export const Batched = Symbol.for("@smthrs/std/file-batch")

/**
 * What one path held when a batched provider looked, all from one round trip.
 *
 * @category models
 * @since 1.0.0-rc.17
 */
export interface Snapshot {
  /**
   * The path with every symbolic link resolved, as `realPath` answers; for
   * an absent path, its parent's resolution joined with its name; absent
   * when the parent is absent too.
   */
  readonly canonical: string | undefined
  /** Opaque. Equal versions mean an unchanged entry; `commit` compares them. */
  readonly version: string
  /** What `stat` answers for the path, following symbolic links. */
  readonly info: Result.Result<
    { readonly type: FileSystem.File.Type; readonly size: number },
    PlatformError.PlatformError
  >
  /**
   * For a path the call asked to read: its bytes, or the failure `readFile`
   * would give. A regular file larger than the call's `maxBytes` has none.
   */
  readonly content?: Result.Result<Uint8Array, PlatformError.PlatformError> | undefined
}

/**
 * One change a batched provider commits, with the version its snapshot saw.
 *
 * @category models
 * @since 1.0.0-rc.17
 */
export interface BatchedChange extends Change {
  readonly version: string
}

/**
 * How far a batched commit got. `stopped` names the change that ended it:
 * `changed` means the entry no longer matched its snapshot, and then nothing
 * was applied. A failure while staging also applies nothing; a failure while
 * renaming or removing leaves the `applied` changes before it in place.
 *
 * @category models
 * @since 1.0.0-rc.17
 */
export interface Committed {
  readonly applied: number
  readonly stopped?: {
    readonly index: number
    readonly reason: "changed" | PlatformError.PlatformError
  } | undefined
}

/**
 * The batched calls, each one round trip.
 *
 * `snapshot` answers one {@link Snapshot} per path, in order, reading the
 * paths in `read`. `commit` first compares every change's version with what
 * is there now and refuses the batch, changing nothing, if any differs. It
 * then stages each write in a temporary file beside its destination,
 * creating missing parents and giving it the mode and owner of the file it
 * replaces (or of `metadataFrom`), and finally renames each write over its
 * destination and removes each removal, in order. `list` names a directory's
 * entries and whether each, following links, is a directory; it fails with
 * `BadResource` for a path that is not a directory.
 *
 * @category models
 * @since 1.0.0-rc.17
 */
export interface BatchedFiles {
  readonly snapshot: (
    paths: ReadonlyArray<string>,
    options?: {
      readonly read?: ReadonlyArray<string> | undefined
      readonly maxBytes?: number | undefined
    }
  ) => Effect.Effect<ReadonlyArray<Snapshot>, PlatformError.PlatformError>
  readonly commit: (changes: ReadonlyArray<BatchedChange>) => Effect.Effect<Committed>
  readonly list: (
    path: string
  ) => Effect.Effect<ReadonlyArray<{ readonly name: string; readonly directory: boolean }>, PlatformError.PlatformError>
}

/**
 * A filesystem that may carry {@link BatchedFiles}.
 *
 * @category models
 * @since 1.0.0-rc.17
 */
export interface BatchedFileSystem extends FileSystem.FileSystem {
  readonly [Batched]?: BatchedFiles
}

const unavailable = () =>
  Effect.fail(
    new StdError.StdError({
      code: "provider_unavailable",
      message: "Authenticated atomic file mutation provider unavailable"
    })
  )

/**
 * Versioned hosts own parent creation and locking inside their atomic commit.
 *
 * @category guards
 * @since 1.0.0
 */
export const isVersioned = (fs: FileSystem.FileSystem): boolean =>
  (fs as VersionedFileSystem)[Preconditions] !== undefined

/**
 * The batched calls of an unversioned filesystem that offers them. Batched
 * hosts, like versioned ones, own parent creation inside their commit.
 *
 * @category guards
 * @since 1.0.0-rc.17
 */
export const batched = (fs: FileSystem.FileSystem): BatchedFiles | undefined =>
  isVersioned(fs) ? undefined : (fs as BatchedFileSystem)[Batched]

const concurrent = (path: string): StdError.StdError =>
  new StdError.StdError({
    code: "no_match",
    message:
      `Concurrent mutation of ${path}: it changed after this call looked at it, so nothing was written. Re-read it and retry.`,
    path
  })

/**
 * Record the entire original file, before pagination, through the host's existing policy.
 *
 * @category filesystem
 * @since 1.0.0
 */
export const recordRead = (fs: FileSystem.FileSystem, path: string, bytes: Uint8Array) =>
  Effect.flatMap(
    ReadSession,
    (session) => (fs as VersionedFileSystem)[Preconditions]?.record(path, bytes, session) ?? Effect.void
  )

/**
 * Refuse an unqualified provider before creating any parent or lock directories.
 *
 * @category filesystem
 * @since 1.0.0
 */
export const validate = (fs: FileSystem.FileSystem, paths: ReadonlyArray<string>) =>
  Effect.gen(function*() {
    const policy = (fs as VersionedFileSystem)[Preconditions]
    if (policy === undefined) return
    const session = yield* ReadSession
    yield* policy.validate(paths, session)
    if (policy.prepare === undefined) return yield* unavailable()
  })

/**
 * The portable body is used only for an ordinary filesystem. `failure` names a
 * read or write failure the way the portable body would; for a batched commit
 * it also learns which change failed and how many before it were applied.
 *
 * @category models
 * @since 1.0.0
 */
export interface Mutation {
  readonly read: (
    path: string,
    failure: (error: PlatformError.PlatformError) => StdError.StdError
  ) => Effect.Effect<Uint8Array, StdError.StdError>
  readonly commit: (
    changes: ReadonlyArray<Change>,
    ordinary: Effect.Effect<void, StdError.StdError>,
    failure: (error: PlatformError.PlatformError, index: number, applied: number) => StdError.StdError
  ) => Effect.Effect<void, StdError.StdError>
  /** What a batched host's snapshot saw at each path it named; only batched hosts have one. */
  readonly seen?: ((path: string) => Snapshot) | undefined
}

/**
 * How a batched host's snapshot is taken: which paths to read, and the
 * failure the call reports when the snapshot itself cannot be taken.
 *
 * @category models
 * @since 1.0.0-rc.17
 */
export interface Batch {
  readonly read: ReadonlyArray<string>
  readonly failure: (error: PlatformError.PlatformError) => StdError.StdError
}

// This serializes one host's preparation, ledger and diagnostic ordering only.
// It is NOT the guest's outside-writer exclusion or its atomic commit boundary.
const hostLocks = new WeakMap<object, Semaphore.Semaphore>()

// The on-disk lock protocol owns this hash; dependency upgrades must not
// change the name and let two versions acquire different locks for one file.
// Case/normalization aliases deliberately share a lock, including on hosts
// whose realPath preserves caller casing. Case-sensitive hosts may refuse a
// simultaneous change to a distinct case variant; that is safe contention.
const lockHash = (value: string): string => {
  value = value.normalize("NFC").toUpperCase()
  let hash = 5381
  for (let index = 0; index < value.length; index++) hash = (hash * 33) ^ value.charCodeAt(index)
  return (hash >>> 0).toString(16)
}

const parent = (path: string) => path.slice(0, path.lastIndexOf(path.startsWith("/") ? "/" : "\\") + 1)

/**
 * Versioned hosts capture bases under a local semaphore until scope exit.
 * Batched hosts take one snapshot of every path, and their commit compares
 * it again, so they hold no lock. Ordinary hosts hold all named files using
 * exclusive mkdir, so independently composed hosts and processes agree.
 * A hash collision only refuses an unrelated edit; it cannot lose exclusion.
 * `batch` says how a batched host's snapshot is taken; without it every path
 * is read and a failed snapshot is reported as a failed read of the first.
 *
 * @private
 * @since 1.0.0
 */
export const acquire = (
  fileSystem: FileSystem.FileSystem,
  paths: ReadonlyArray<string>,
  creationPaths?: Path.Path,
  batch?: Batch
): Effect.Effect<Mutation, StdError.StdError, Scope.Scope> =>
  Effect.gen(function*() {
    // Unavailable coding providers refuse before acquiring even protocol state.
    // The versioned provider owns exclusion and revalidation at its commit;
    // cooperative caller-side locks cannot exclude terminal or SSH writers.
    yield* validate(fileSystem, paths)
    const policy = (fileSystem as VersionedFileSystem)[Preconditions]
    if (policy !== undefined) {
      let lock = hostLocks.get(policy)
      if (lock === undefined) {
        lock = Semaphore.makeUnsafe(1)
        hostLocks.set(policy, lock)
      }
      const held = lock
      yield* Effect.acquireRelease(held.take(1), () => held.release(1), { interruptible: true })
      const session = yield* ReadSession
      const prepared = yield* policy.prepare!(paths, session)
      return { read: (path) => prepared.read(path), commit: (changes) => prepared.commit(changes) }
    }
    const files = batched(fileSystem)
    if (files !== undefined) {
      // An empty patch names nothing and costs no round trip.
      const named = [...new Set(paths)]
      const snapshots = named.length === 0 ? [] : yield* files.snapshot(named, { read: batch?.read ?? named }).pipe(
        Effect.mapError(batch?.failure ?? FsFailure.reading(named[0]!, `File not found: ${named[0]}`))
      )
      const seen = new Map(named.map((path, index) => [path, snapshots[index]!]))
      return {
        // A flow reads only the paths it named in `batch.read`.
        read: (path, failure) => Effect.mapError(Effect.fromResult(seen.get(path)!.content!), failure),
        commit: (changes, _ordinary, failure) =>
          changes.length === 0 ? Effect.void : Effect.flatMap(
            files.commit(changes.map((change) => ({ ...change, version: seen.get(change.path)!.version }))),
            ({ applied, stopped }) => {
              if (stopped === undefined) return Effect.void
              return Effect.fail(
                stopped.reason === "changed"
                  ? concurrent(changes[stopped.index]!.path)
                  : failure(stopped.reason, stopped.index, applied)
              )
            }
          ),
        seen: (path) => seen.get(path)!
      }
    }
    const locks = new Map<string, string>()
    for (const path of paths) {
      const destination = yield* fileSystem.realPath(path).pipe(
        Effect.catch((error) =>
          error.reason._tag === "NotFound" && creationPaths !== undefined
            ? fileSystem.realPath(creationPaths.dirname(path)).pipe(
              Effect.map((directory) => creationPaths.join(directory, creationPaths.basename(path)))
            )
            : Effect.fail(error)
        ),
        Effect.mapError(FsFailure.reading(path, `File not found: ${path}`))
      )
      const lock = `${parent(destination)}.smithers-${lockHash(destination)}.lock`
      locks.set(lock, path)
    }
    for (const [lock, path] of [...locks].sort(([left], [right]) => left.localeCompare(right))) {
      yield* Effect.acquireRelease(
        fileSystem.makeDirectory(lock, { mode: 0o700 }).pipe(
          Effect.mapError(FsFailure.denied(path, (error) =>
            new StdError.StdError({
              code: error.reason._tag === "AlreadyExists" ? "no_match" : "command_failed",
              message: error.reason._tag === "AlreadyExists"
                ? `Concurrent mutation of ${path}: lock ${lock} is held. Re-read and retry after the other writer finishes; a stopped writer's lock requires explicit recovery.`
                : `Could not lock ${path} for mutation`,
              path
            })))
        ),
        () => fileSystem.remove(lock, { recursive: true }).pipe(Effect.orDie)
      )
    }
    return {
      read: (path, failure) => Effect.mapError(fileSystem.readFile(path), failure),
      commit: (_changes, ordinary) => ordinary
    }
  })
