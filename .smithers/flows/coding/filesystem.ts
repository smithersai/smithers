/** The coding host's one run-scoped std read ledger and atomic provider boundary. */
import { Preconditions, type VersionedFileSystem } from "@smthrs/std/Read"
import { StdError } from "@smthrs/std/StdError"
import { Cause, Effect, type FileSystem, PlatformError, Sink, Stream } from "effect"
import { ChildProcess, type ChildProcessSpawner } from "effect/process"
import { spawn } from "node:child_process"
import { createHash, randomBytes } from "node:crypto"
import { constants as fsConstants, existsSync } from "node:fs"
import { type FileHandle, mkdir, open, rename, unlink } from "node:fs/promises"
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path"
import type { NativeOptions } from "./native.ts"

/** Installed authority only. The provider must authenticate the registered run,
 * confine paths and compare every base before settling the complete batch.
 * A stale preflight changes no bytes. ADR 0004 application failures may retain
 * a prefix; they must be reported as failures, never stale or success.
 * The host must never adapt ordered single-file writes to this transaction.
 */
export interface MutationProvider {
  /** The provider's own read of a file's current bytes, by root-relative path;
   * undefined when absent. Without it the host reads through its filesystem. */
  readonly read?: (path: string) => Effect.Effect<Uint8Array | undefined, StdError>
  readonly commit: (
    session: string,
    changes: ReadonlyArray<{ readonly path: string; readonly base_digest: string; readonly content: Uint8Array | null }>
  ) => Effect.Effect<void, StdError>
}

const unavailable = () =>
  Effect.fail(
    new StdError({
      code: "provider_unavailable",
      message: "Authenticated file mutation provider unavailable"
    })
  )
const digest = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex")
const stale = (path: string, base: string, current: string) =>
  Effect.fail(
    new StdError({
      code: "stale_read",
      path,
      base_digest: base,
      current_digest: current,
      message: `Re-read ${path}`
    })
  )

/** ADR 0004's installed client owns the codec and kernel-derived run identity.
 * Never send the model-facing ledger's session string as authentication. The
 * installed local client submits a whole batch; preflight stale changes no bytes.
 * Application failures may retain a durable prefix and require fresh reads.
 */
const daemonProvider = (
  spawner: ChildProcessSpawner.ChildProcessSpawner["Service"]
): MutationProvider => ({
  commit: (_session, changes) =>
    Effect.gen(function*() {
      if (changes.length === 0 || changes.length > 256) return yield* unavailable()
      const batch = changes.length !== 1 || changes[0]!.content === null
      const change = changes[0]!
      let total = 0
      for (const change of changes) {
        total += change.content?.byteLength ?? 0
        if (
          total > 1024 * 1024 ||
          (change.base_digest !== "absent" && !/^[0-9a-f]{64}$/.test(change.base_digest))
        ) return yield* unavailable()
      }
      const child = yield* spawner.spawn(ChildProcess.make(
        "/opt/smithers/bin/smithers-machined",
        batch ? ["client", "write-files"] : ["client", "write-file", change.path, "--base", change.base_digest],
        {
          cwd: "/workspace",
          stdin: Stream.make(
            batch
              ? new TextEncoder().encode(JSON.stringify(changes.map((change) => ({
                ...change,
                content: change.content === null ? null : Array.from(change.content)
              }))))
              : change.content!
          )
        }
      ))
      const capture = (stream: typeof child.stdout, limit = 64 * 1024) =>
        Stream.runFoldEffect(
          stream,
          () => ({ size: 0, text: "", decoder: new TextDecoder() }),
          (state, bytes) =>
            state.size + bytes.length > limit ? unavailable() : Effect.succeed({
              size: state.size + bytes.length,
              text: state.text + state.decoder.decode(bytes, { stream: true }),
              decoder: state.decoder
            })
        ).pipe(Effect.map((state) => state.text + state.decoder.decode()))
      const [output, , exit] = yield* Effect.all([
        capture(child.stdout, batch ? 8 * 1024 * 1024 : 64 * 1024),
        capture(child.stderr),
        child.exitCode
      ], { concurrency: "unbounded" })
      const reply: unknown = yield* Effect.try(() => JSON.parse(output))
      if (typeof reply !== "object" || reply === null || Array.isArray(reply)) return yield* unavailable()
      if (batch && "writes" in reply) {
        if (!Array.isArray(reply.writes) || reply.writes.length > changes.length) return yield* unavailable()
        for (let i = 0; i < reply.writes.length; i++) {
          const receipt = reply.writes[i], expected = changes[i]!
          if (
            typeof receipt !== "object" || receipt === null || receipt.path !== expected.path ||
            receipt.post_digest !== (expected.content === null ? "absent" : digest(expected.content)) ||
            (receipt.raced !== undefined &&
              (typeof receipt.raced !== "string" || !/^[0-9a-f]{64}$/.test(receipt.raced)))
          ) {
            return yield* unavailable()
          }
        }
        if ("failure" in reply) {
          const failure = reply.failure
          if (
            exit === 0 || typeof failure !== "object" || failure === null || !("index" in failure) ||
            typeof failure.index !== "number" || !Number.isInteger(failure.index) ||
            failure.index < 0 || failure.index >= changes.length || !("preflight" in failure) ||
            typeof failure.preflight !== "boolean" || !("code" in failure) ||
            typeof failure.code !== "number" || !Number.isInteger(failure.code) || failure.code < 1 ||
            failure.code > 12 ||
            (failure.preflight ? reply.writes.length !== 0 : failure.index !== reply.writes.length)
          ) return yield* unavailable()
          const refused = changes[failure.index]!
          if (failure.preflight && failure.code === 4) {
            const current = "current_digest" in failure ? failure.current_digest : "absent"
            if (
              typeof current !== "string" || (current !== "absent" && !/^[0-9a-f]{64}$/.test(current))
            ) return yield* unavailable()
            return yield* stale(refused.path, refused.base_digest, current)
          }
          if (failure.preflight && failure.code === 10) {
            return yield* Effect.fail(
              new StdError({
                code: "moved_off",
                path: refused.path,
                message: "Branch moved off the item"
              })
            )
          }
          return yield* Effect.fail(
            new StdError({
              code: "command_failed",
              path: refused.path,
              message: `Patch stopped after ${reply.writes.length} files; re-read all affected paths`
            })
          )
        }
        if (exit !== 0 || reply.writes.length !== changes.length) return yield* unavailable()
        return
      }
      // A singleton error cannot establish a batch preflight refusal or name
      // its stopped path. Require the batch receipt before reporting stale.
      if (batch) return yield* unavailable()
      if ("error" in reply) {
        const error = reply.error
        if (exit === 0 || typeof error !== "object" || error === null || !("code" in error)) {
          return yield* unavailable()
        }
        if (error.code === "moved_off") {
          return yield* Effect.fail(
            new StdError({ code: "moved_off", path: change.path, message: "Branch moved off the item" })
          )
        }
        if (error.code !== "stale") return yield* unavailable()
        const current = "current_digest" in error ? error.current_digest : "absent"
        if (
          typeof current !== "string" || (current !== "absent" && !/^[0-9a-f]{64}$/.test(current))
        ) return yield* unavailable()
        return yield* stale(change.path, change.base_digest, current)
      }
      if (
        exit !== 0 || !("post_digest" in reply) || reply.post_digest !== digest(change.content!)
      ) return yield* unavailable()
    }).pipe(
      Effect.scoped,
      Effect.timeout("45 seconds"),
      Effect.catchCause((cause) => {
        if (Cause.hasInterruptsOnly(cause)) return Effect.interrupt
        const error = Cause.squash(cause)
        return error instanceof StdError ? Effect.fail(error) : unavailable()
      })
    )
})

const MAX_BATCH_FILES = 256
const MAX_BATCH_BYTES = 1024 * 1024

/** The working copy a hosted developer box serves; no machine broker runs there. */
export const HOSTED_ROOT = "/home/developer/workspace"

const refused = (path: string, why: string) =>
  new StdError({ code: "permission_denied", path, message: `Cannot change ${path}: ${why}` })

/**
 * Directory-anchored file access. Node has no openat, so each component is
 * opened through the already-open directory's `/proc/self/fd/<fd>` link with
 * O_NOFOLLOW: resolution starts at that directory itself, never at its name,
 * and a link at the component is refused. Swapping a checked directory for a
 * link after it was opened cannot redirect anything. Linux only; elsewhere
 * every operation refuses.
 *
 * @private
 */
export const Anchored = {
  available: (): boolean => process.platform === "linux" && existsSync("/proc/self/fd"),
  at: (directory: FileHandle, name: string): string => `/proc/self/fd/${directory.fd}/${name}`,
  /** Opens `root` and each directory in `segments` beneath it. With `create`
   * a missing directory is made in its anchored parent; without it a missing
   * one ends the walk early. The caller closes every returned handle. */
  directories: async (
    root: string,
    segments: ReadonlyArray<string>,
    path: string,
    create: boolean
  ): Promise<{ readonly opened: Array<FileHandle>; readonly complete: boolean }> => {
    if (!Anchored.available()) {
      throw new StdError({ code: "provider_unavailable", message: "Anchored file access needs Linux" })
    }
    const flags = fsConstants.O_RDONLY | fsConstants.O_DIRECTORY | fsConstants.O_NOFOLLOW
    const opened = [await open(root, flags)]
    try {
      for (const segment of segments) {
        const parent = opened.at(-1)!
        const next = await open(Anchored.at(parent, segment), flags).catch(async (error: NodeJS.ErrnoException) => {
          if (error.code !== "ENOENT") {
            throw error.code === "ELOOP" || error.code === "ENOTDIR"
              ? refused(path, "it traverses a symbolic link or a file")
              : error
          }
          if (!create) return undefined
          await mkdir(Anchored.at(parent, segment)).catch((made: NodeJS.ErrnoException) => {
            if (made.code !== "EEXIST") throw made
          })
          return open(Anchored.at(parent, segment), flags).catch((again: NodeJS.ErrnoException) => {
            throw again.code === "ELOOP" || again.code === "ENOTDIR"
              ? refused(path, "it traverses a symbolic link or a file")
              : again
          })
        })
        if (next === undefined) return { opened, complete: false }
        opened.push(next)
      }
      return { opened, complete: true }
    } catch (error) {
      await Promise.all(opened.map((handle) => handle.close()))
      throw error
    }
  },
  /** A regular file's bytes and mode, never through a link; undefined when absent. */
  read: async (directory: FileHandle, name: string, path: string) => {
    // O_NONBLOCK: a FIFO committed to the tree is refused below, never waited on.
    const flags = fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK
    const file = await open(Anchored.at(directory, name), flags).catch(
      (error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return undefined
        throw error.code === "ELOOP" ? refused(path, "it is a symbolic link") : error
      }
    )
    if (file === undefined) return undefined
    try {
      const info = await file.stat()
      if (!info.isFile()) throw refused(path, "it is not a regular file")
      // A hard link could name a file outside the tree under an inside name.
      if (info.nlink > 1) throw refused(path, "it is hard-linked")
      return { bytes: new Uint8Array(await file.readFile()), mode: info.mode & 0o7777 }
    } finally {
      await file.close()
    }
  },
  /** Takes a workspace's one edit lock, waiting up to `waitMillis` for it, and
   * returns the handle that holds it; closing the handle releases it. The lock
   * is an exclusive flock(2) on the root directory itself, so nothing is
   * created in the tree, every provider in every process meets on the same
   * inode, and the kernel releases it when the holder dies. Node has no
   * flock, so util-linux's `flock` takes it on the handle it inherits. */
  exclusive: async (root: string, waitMillis = 30_000): Promise<FileHandle> => {
    const held = await open(root, fsConstants.O_RDONLY | fsConstants.O_DIRECTORY | fsConstants.O_NOFOLLOW)
    try {
      const status = await new Promise<number | null>((settle, fail) => {
        const taker = spawn("flock", ["-x", "3"], {
          stdio: ["ignore", "ignore", "ignore", held.fd],
          timeout: waitMillis,
          killSignal: "SIGKILL"
        })
        taker.once("error", fail)
        taker.once("exit", settle)
      })
      if (status !== 0) {
        throw new StdError({
          code: "provider_unavailable",
          message: "Another edit still holds the workspace; nothing changed"
        })
      }
      return held
    } catch (error) {
      await held.close()
      throw error
    }
  }
}

const close = (handles: ReadonlyArray<FileHandle>) => Promise.all(handles.map((handle) => handle.close()))

/** The workspace owner's own provider, for a box with no machine broker.
 * It reads and writes as this process's uid, which already owns the tree, so
 * it adds no authority. Every access is directory-anchored ({@link Anchored}):
 * no symbolic link is followed and nothing outside the root is reached, even
 * if the tree changes during the call. It refuses version-control metadata,
 * where the host's own jj and git would run a planted hook or configuration.
 * Every base is compared before any byte changes, so a stale batch changes
 * nothing. Each file is replaced by an fsynced rename inside its anchored
 * directory and keeps its mode. A failure part-way through a batch is reported
 * as a stopped patch, never as stale or success.
 *
 * A commit holds the workspace's edit lock ({@link Anchored.exclusive}) from
 * its first base check to its last replace, so two providers, in one process
 * or two, never overwrite each other. Each file's digest is read again just
 * before its rename, and a change seen there is refused as stale. That is the
 * whole guarantee: Node cannot compare and replace in one kernel step, so a
 * writer that does not take the lock (a shell in the box, a build) and writes
 * between that last read and the rename is still overwritten. Closing that
 * window needs the kernel-atomic exchange of the deferred daemon provider
 * (https://github.com/smithersai/smithers/issues/3508).
 */
export const localProvider = (canonicalRoot: string): MutationProvider => {
  const root = resolve(canonicalRoot)
  /** The checked components of one root-relative path. */
  const components = (path: string) => {
    const suffix = relative(root, resolve(root, path))
    if (suffix === "" || suffix === ".." || suffix.startsWith(`..${sep}`) || isAbsolute(suffix)) {
      throw refused(path, "it is outside the workspace")
    }
    const segments = suffix.split(sep)
    if (segments.some((segment) => segment === ".git" || segment === ".jj")) {
      throw refused(path, "it is version-control metadata")
    }
    return { directories: segments.slice(0, -1), name: segments.at(-1)! }
  }
  const current = async (path: string) => {
    const { directories, name } = components(path)
    const walked = await Anchored.directories(root, directories, path, false)
    try {
      return walked.complete ? await Anchored.read(walked.opened.at(-1)!, name, path) : undefined
    } finally {
      await close(walked.opened)
    }
  }
  const apply = async (path: string, base: string, content: Uint8Array | null) => {
    const { directories, name } = components(path)
    const walked = await Anchored.directories(root, directories, path, content !== null)
    try {
      if (!walked.complete) return
      const directory = walked.opened.at(-1)!
      /** The file as it is now, refused as stale unless it still has the base digest. */
      const unchanged = async () => {
        const existing = await Anchored.read(directory, name, path)
        const observed = existing === undefined ? "absent" : digest(existing.bytes)
        if (observed !== base) {
          throw new StdError({
            code: "stale_read",
            path,
            base_digest: base,
            current_digest: observed,
            message: `Re-read ${path}`
          })
        }
        return existing
      }
      // Compare again inside the anchored directory: a write that landed after
      // the batch's base check is refused before any temporary file is made.
      const existing = await unchanged()
      if (content === null) {
        if (existing !== undefined) await unlink(Anchored.at(directory, name))
        return
      }
      const temporary = `.${name}.smithers-${randomBytes(6).toString("hex")}.tmp`
      const mode = existing === undefined ? 0o666 : existing.mode
      const file = await open(
        Anchored.at(directory, temporary),
        fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW,
        mode
      )
      try {
        try {
          await file.writeFile(content)
          if (existing !== undefined) await file.chmod(mode)
          await file.sync()
        } finally {
          await file.close()
        }
        // Compare once more as the last step before the replace, so a write
        // made while the new bytes were written and synced is refused too.
        // A writer outside the edit lock can still land between this read and
        // the rename and be overwritten (#3508).
        await unchanged()
        await rename(Anchored.at(directory, temporary), Anchored.at(directory, name))
      } catch (error) {
        await unlink(Anchored.at(directory, temporary)).catch(() => {})
        throw error
      }
    } finally {
      await close(walked.opened)
    }
  }
  const checkedRead = (path: string) =>
    Effect.tryPromise({
      try: async () => (await current(path))?.bytes,
      catch: (error) =>
        error instanceof StdError
          ? error
          : new StdError({ code: "permission_denied", path, message: `Could not read ${path}` })
    })
  return {
    read: checkedRead,
    commit: (_session, changes) =>
      Effect.gen(function*() {
        const total = changes.reduce((sum, change) => sum + (change.content?.byteLength ?? 0), 0)
        if (changes.length === 0 || changes.length > MAX_BATCH_FILES || total > MAX_BATCH_BYTES) {
          return yield* unavailable()
        }
        // One lock from the first base check to the last replace: no other
        // provider's commit runs between this one's compares and its renames.
        yield* Effect.acquireUseRelease(
          Effect.tryPromise({
            try: () => Anchored.exclusive(root),
            catch: (error) =>
              error instanceof StdError
                ? error
                : new StdError({ code: "provider_unavailable", message: "The workspace edit lock is unavailable" })
          }),
          () =>
            Effect.gen(function*() {
              for (const change of changes) {
                const bytes = yield* checkedRead(change.path)
                const observed = bytes === undefined ? "absent" : digest(bytes)
                if (observed !== change.base_digest) return yield* stale(change.path, change.base_digest, observed)
              }
              for (const [applied, change] of changes.entries()) {
                yield* Effect.tryPromise({
                  try: () => apply(change.path, change.base_digest, change.content),
                  catch: (error) =>
                    error instanceof StdError && applied === 0 ? error : new StdError({
                      code: "command_failed",
                      path: change.path,
                      message: `Patch stopped after ${applied} files; re-read all affected paths`
                    })
                })
              }
            }),
          (held) => Effect.promise(() => held.close())
        )
      }).pipe(Effect.uninterruptible)
  }
}

/** Model-facing reads confined to the workspace. A path, after every link in
 * it is resolved, must name the root or something inside it, so a link that
 * leaves the tree, an absolute path elsewhere (/proc, /etc, the home's caches)
 * and a ../ escape are refused before any byte is read. Links inside the tree,
 * such as a package manager's, still resolve.
 */
export const confineReads = <F extends FileSystem.FileSystem>(fs: F, canonicalRoot: string): F => {
  const root = resolve(canonicalRoot)
  const within = (path: string) => {
    const suffix = relative(root, path)
    return suffix === "" || (suffix !== ".." && !suffix.startsWith(`..${sep}`) && !isAbsolute(suffix))
  }
  const denied = (method: string, path: string) =>
    PlatformError.systemError({
      _tag: "PermissionDenied",
      module: "FileSystem",
      method,
      pathOrDescriptor: path,
      description: "Outside the workspace"
    })
  /** Where a path leads: its real path, a dangling link's target followed in
   * turn, or the nearest existing ancestor's real path joined with the rest. */
  const real = (absolute: string, depth = 0): Effect.Effect<string, PlatformError.PlatformError> =>
    fs.realPath(absolute).pipe(
      Effect.catch((error) =>
        error.reason._tag !== "NotFound" || depth > 40 || dirname(absolute) === absolute
          ? Effect.fail(error)
          : fs.readLink(absolute).pipe(
            Effect.matchEffect({
              onSuccess: (target) => real(resolve(dirname(absolute), target), depth + 1),
              onFailure: () =>
                Effect.map(real(dirname(absolute), depth + 1), (parent) => join(parent, basename(absolute)))
            })
          )
      )
    )
  /** The absolute path a read may use, or a refusal that reads nothing. */
  const guard = (method: string, path: string) => {
    const absolute = resolve(root, path)
    return within(absolute)
      ? Effect.flatMap(
        real(absolute),
        (resolved) => within(resolved) ? Effect.succeed(absolute) : Effect.fail(denied(method, path))
      )
      : Effect.fail(denied(method, path))
  }
  return {
    ...fs,
    access: (path, options) => Effect.flatMap(guard("access", path), (absolute) => fs.access(absolute, options)),
    exists: (path) => Effect.flatMap(guard("exists", path), (absolute) => fs.exists(absolute)),
    glob: (pattern, options) =>
      Effect.flatMap(
        guard("glob", options?.root ?? root),
        (absolute) => fs.glob(pattern, { ...options, root: absolute })
      ),
    readDirectory: (path, options) =>
      Effect.flatMap(guard("readDirectory", path), (absolute) => fs.readDirectory(absolute, options)),
    readFile: (path) => Effect.flatMap(guard("readFile", path), (absolute) => fs.readFile(absolute)),
    readFileString: (path, encoding) =>
      Effect.flatMap(guard("readFileString", path), (absolute) => fs.readFileString(absolute, encoding)),
    readLink: (path) => Effect.flatMap(guard("readLink", path), (absolute) => fs.readLink(absolute)),
    realPath: (path) => Effect.flatMap(guard("realPath", path), (absolute) => fs.realPath(absolute)),
    stat: (path) => Effect.flatMap(guard("stat", path), (absolute) => fs.stat(absolute)),
    open: (path, options) => Effect.flatMap(guard("open", path), (absolute) => fs.open(absolute, options)),
    stream: (path, options) =>
      Stream.unwrap(Effect.map(guard("stream", path), (absolute) => fs.stream(absolute, options))),
    watch: (path, options) => Stream.unwrap(Effect.map(guard("watch", path), (absolute) => fs.watch(absolute, options)))
  }
}

const Mutable = Symbol.for("@smthrs/coding/file-mutations")

/** Whether a coding filesystem has a provider to apply edits; the host offers
 * `write`, `edit` and `apply_patch` only when it does. */
export const mutable = (fs: FileSystem.FileSystem): boolean =>
  (fs as { readonly [Mutable]?: boolean })[Mutable] === true

/** A new filesystem instance has no inherited read authority, including on resume.
 * Only successful model-facing reads record bases. Mutation-internal reads do not.
 */
export const make = (
  options: NativeOptions,
  fs: FileSystem.FileSystem,
  spawner: ChildProcessSpawner.ChildProcessSpawner["Service"],
  canonicalRoot: string,
  suppliedProvider?: MutationProvider
): VersionedFileSystem => {
  const root = resolve(options.repositoryPath)
  const pinnedRoot = resolve(canonicalRoot)
  // The shipped broker's socket is bound to this fixed guest workspace. A
  // different root must never accidentally write into that machine's branch.
  const provider = suppliedProvider ?? (pinnedRoot === resolve("/workspace") ? daemonProvider(spawner) : undefined)
  const ledgers = new Map<string, Map<string, string>>()
  const key = (path: string) => {
    const absolute = resolve(root, path)
    const suffix = relative(root, absolute)
    const canonicalSuffix = relative(pinnedRoot, absolute)
    const inside = (value: string) =>
      value !== "" && value !== ".." && !value.startsWith(`..${sep}`) && !isAbsolute(value)
    const target = inside(suffix) ? suffix : canonicalSuffix
    if (!inside(target)) return undefined
    return target.split(sep).join("/")
  }
  const authority = (session: string | undefined) =>
    session === undefined || session === "" || provider === undefined ? unavailable() : Effect.succeed(session)
  const current = (path: string, target: string) =>
    provider?.read !== undefined
      ? provider.read(target).pipe(
        Effect.map((bytes) => ({ bytes, digest: bytes === undefined ? "absent" : digest(bytes) }))
      )
      : fs.readFile(path).pipe(
        Effect.map((bytes) => ({ bytes, digest: digest(bytes) })),
        Effect.catch((error) =>
          error.reason._tag === "NotFound"
            ? Effect.succeed({ bytes: undefined, digest: "absent" })
            : Effect.fail(new StdError({ code: "permission_denied", path, message: `Could not read ${path}` }))
        )
      )
  const prepare: NonNullable<NonNullable<VersionedFileSystem[typeof Preconditions]>["prepare"]> = (paths, session) =>
    Effect.gen(function*() {
      const run = yield* authority(session)
      const bases = new Map<string, { path: string; base: string; bytes: Uint8Array | undefined }>()
      for (const path of paths) {
        const target = key(path)
        if (target === undefined || bases.has(target)) return yield* unavailable()
        const observed = yield* current(path, target)
        const base = ledgers.get(run)?.get(target) ?? (observed.digest === "absent" ? "absent" : "unread")
        if (base !== observed.digest) return yield* stale(path, base, observed.digest)
        bases.set(target, { path, base, bytes: observed.bytes?.slice() })
      }
      let committed = false
      return {
        read: (path: string) =>
          Effect.suspend(() => {
            const target = key(path)
            const captured = target === undefined ? undefined : bases.get(target)
            if (captured === undefined) return unavailable()
            if (captured.bytes === undefined) {
              return Effect.fail(new StdError({ code: "not_found", path, message: `File not found: ${path}` }))
            }
            return Effect.succeed(captured.bytes.slice())
          }),
        commit: (changes) =>
          Effect.gen(function*() {
            if (committed || changes.length === 0) return yield* unavailable()
            const seen = new Set<string>()
            const request: Array<{ path: string; base_digest: string; content: Uint8Array | null }> = []
            for (const change of changes) {
              const target = key(change.path)
              const captured = target === undefined ? undefined : bases.get(target)
              if (target === undefined || captured === undefined || seen.has(target)) return yield* unavailable()
              seen.add(target)
              request.push({ path: target, base_digest: captured.base, content: change.content?.slice() ?? null })
            }
            // A provider's interruption/failure can have an unknown outcome. Never
            // reuse this prepared invocation or claim its ledger advanced.
            committed = true
            yield* provider!.commit(run, request).pipe(Effect.catchCause((cause) => {
              // Only a validated preflight refusal establishes an unchanged
              // batch. Transport errors, invalid receipts and interruption can
              // hide an applied prefix, including a stopped path with old bytes.
              const error = Cause.squash(cause)
              if (
                !(error instanceof StdError) ||
                (error.code !== "stale_read" && error.code !== "moved_off")
              ) {
                for (const change of request) ledgers.get(run)?.delete(change.path)
              }
              return Effect.failCause(cause)
            }))
            let ledger = ledgers.get(run)
            if (ledger === undefined) {
              ledger = new Map()
              ledgers.set(run, ledger)
            }
            for (const change of request) {
              ledger.set(change.path, change.content === null ? "absent" : digest(change.content))
            }
          }).pipe(Effect.uninterruptible)
      }
    })
  const denied = (method: string) =>
    Effect.fail(PlatformError.systemError({
      _tag: "PermissionDenied",
      module: "FileSystem",
      method,
      description: "Coding mutations require an authenticated atomic provider"
    }))
  const coding: VersionedFileSystem & { readonly [Mutable]: boolean } = {
    ...fs,
    [Mutable]: provider !== undefined,
    [Preconditions]: {
      record: (path, bytes, session) =>
        Effect.sync(() => {
          const target = key(path)
          if (target === undefined || session === undefined || session === "") return
          let ledger = ledgers.get(session)
          if (ledger === undefined) {
            ledger = new Map()
            ledgers.set(session, ledger)
          }
          ledger.set(target, digest(bytes))
        }),
      validate: (_paths, session) => authority(session).pipe(Effect.asVoid),
      prepare
    },
    writeFile: () => denied("writeFile"),
    writeFileString: () => denied("writeFileString"),
    rename: () => denied("rename"),
    remove: () => denied("remove"),
    copy: () => denied("copy"),
    copyFile: () => denied("copyFile"),
    makeDirectory: () => denied("makeDirectory"),
    open: (path, options) =>
      options?.flag === undefined || options.flag === "r" ? fs.open(path, options) : denied("open"),
    sink: () =>
      Sink.fail(PlatformError.systemError({ _tag: "PermissionDenied", module: "FileSystem", method: "sink" })),
    truncate: () => denied("truncate"),
    link: () => denied("link"),
    symlink: () => denied("symlink"),
    utimes: () => denied("utimes"),
    chmod: () => denied("chmod"),
    chown: () => denied("chown"),
    makeTempDirectory: () => denied("makeTempDirectory"),
    makeTempDirectoryScoped: () => denied("makeTempDirectoryScoped"),
    makeTempFile: () => denied("makeTempFile"),
    makeTempFileScoped: () => denied("makeTempFileScoped")
  }
  return coding
}
