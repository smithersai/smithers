/**
 * Constructs the Jujutsu-workspace sandbox provider.
 *
 * @since 1.0.0
 */

import { isJjError, type Jj, type JjError, type JjFailure, type Revision } from "@smthrs/jj"
import * as ChildProcessEnvironment from "@smthrs/kernel/ChildProcessEnvironment"
import * as ContainedSpawner from "@smthrs/kernel/ContainedSpawner"
import * as Cause from "effect/Cause"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import type * as FileSystem from "effect/FileSystem"
import * as Option from "effect/Option"
import type * as Path from "effect/Path"
import type * as PlatformError from "effect/PlatformError"
import * as ChildProcess from "effect/process/ChildProcess"
import type { ChildProcessHandle, ChildProcessSpawner } from "effect/process/ChildProcessSpawner"
import type { Scope } from "effect/Scope"
import * as Semaphore from "effect/Semaphore"
import * as Stream from "effect/Stream"
import { credentialFiles } from "../internal/credentialFiles.ts"
import { checkEnvironmentNames } from "../internal/environmentNames.ts"
import { gather, providerFailure, remoteProcessOf } from "../internal/localProcess.ts"
import { rootedAt } from "../internal/rootedPath.ts"
import { sessionSlug } from "../internal/sessionSlug.ts"
import type { RemoteProcess } from "../RemoteChildProcessSpawner/Provider.ts"
import { ProviderError } from "../RemoteChildProcessSpawner/ProviderError.ts"
import { type NetworkPolicy, refuseNetworkPolicy } from "../Sandbox/NetworkPolicy.ts"
import type { Provider } from "../Sandbox/Provider.ts"
import { refuseResourceLimits, type ResourceLimits } from "../Sandbox/ResourceLimits.ts"
import type { Session } from "../Sandbox/Session.ts"

/**
 * Default prefix prepended to derived Jujutsu workspace names so a workspace
 * name never starts with `-` or `.` and never collides with jj's `"default"`
 * primary workspace.
 *
 * @category constants
 * @since 1.0.0
 */
export const defaultWorkspacePrefix = "smthrs-ws-"

const workspacePrefixPattern = /^[A-Za-z0-9][A-Za-z0-9_-]{0,31}$/
const absolutePathPattern = /^(?:\/|[A-Za-z]:[\\/]|\\\\)/
const fullCommitIdPattern = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/
const allZerosPattern = /^0+$/
const revisionShapePattern = /^(?:@-?|[0-9a-f]+|[k-z]+)$/
const vcsMetadataSegmentPattern = /^\.(?:git|jj)$/i

const isMaterialFullCommitId = (value: string): boolean =>
  fullCommitIdPattern.test(value) && !allZerosPattern.test(value)

const hasVcsMetadataSegment = (value: string): boolean =>
  value.split(/[\\/]/).some((segment) => vcsMetadataSegmentPattern.test(segment))

const validatePrefix = (prefix: string): string => {
  if (!workspacePrefixPattern.test(prefix)) {
    throw new TypeError(
      `jj-workspace-sandbox: workspacePrefix must match ${workspacePrefixPattern}, got ${JSON.stringify(prefix)}`
    )
  }
  return prefix.toLowerCase()
}

/**
 * Derives the deterministic, safe Jujutsu workspace name (and directory leaf)
 * for `session`.
 *
 * The result is lowercase ASCII matching `[a-z0-9][a-z0-9_-]+`, bounded in
 * length, and ends with `sessionSlug`'s 64-bit digest over the raw UTF-16
 * `session` key so `"lane/one"`, `"lane-one"`, `"Lane"`, `"lane"`, and keys
 * diverging past 40 characters map to distinct workspaces across both
 * case-sensitive and case-insensitive filesystems.
 *
 * @category utils
 * @since 1.0.0
 */
export const workspaceNameOf = (session: string, prefix: string = defaultWorkspacePrefix): string => {
  const normalizedPrefix = validatePrefix(prefix)
  const slug = sessionSlug(session).toLowerCase().replaceAll(/[^a-z0-9_-]/g, "-")
  return `${normalizedPrefix}${slug}`
}

/**
 * One step of a workspace's teardown that failed.
 *
 * - `kill`: a command the session started could not be signalled, so it may
 *   still be running.
 * - `forget`: jj still lists the workspace.
 * - `remove`: the workspace directory is still on disk.
 *
 * @category models
 * @since 1.0.0
 */
export interface TeardownFailure {
  readonly step: "kill" | "forget" | "remove"
  /** The session key the workspace was acquired under. */
  readonly session: string
  /** The jj workspace name, as `jj workspace list` prints it. */
  readonly workspace: string
  /** The workspace directory path. */
  readonly workdir: string
  /** The failure raised by the step. */
  readonly cause: unknown
}

/**
 * What the Jujutsu-workspace provider needs from its host.
 *
 * Every host capability (`jj`, `fs`, `path`, `spawner`, and optional bootstrap
 * `env`) arrives as a value rather than an ambient import or global read, so
 * this module stays 100% platform-neutral and browser/Worker bundleable.
 *
 * @category models
 * @since 1.0.0
 */
export interface JjWorkspaceSandboxOptions {
  /**
   * Restrictions refused: commands run as host processes with the host's
   * network. `"none"` or an allowlist makes `make` throw rather than hand out
   * a machine with a network it did not ask for; `"open"`, which restricts
   * nothing, is accepted.
   */
  readonly network?: NetworkPolicy | undefined
  /**
   * Refused: commands run as host processes. Setting any ceiling makes `make`
   * throw rather than hand out a machine without it.
   */
  readonly limits?: ResourceLimits | undefined
  /** The host Jujutsu capability bound to the source repository (`NodeJj.layerAt` / `NodeJj.layerSpawnerAt`). */
  readonly jj: Jj
  /** The host filesystem the workspace directories live on. */
  readonly fs: FileSystem.FileSystem
  /** The host path dialect used to resolve and confine workspace directories and git pointers. */
  readonly path: Path.Path
  /** A host spawner with a platform lifecycle; raw and deadline-only spawners are refused. */
  readonly spawner: ChildProcessSpawner["Service"]
  /** The absolute host directory workspaces are created under; a relative path, control byte, or VCS segment throws. */
  readonly workspacesRoot: string
  /**
   * Revision every newly acquired workspace starts at.
   *
   * When `git` is enabled (the default), must be a full non-zero 40- or
   * 64-character hex commit id; omit to snapshot the repository's working copy
   * via `jj.snapshot()` at each `acquire`. When `git` is `false`, accepts any
   * `Jj.Revision` (`@`, `@-`, commit id prefix, or change id prefix), or omit
   * to let `jj` use its repository default.
   */
  readonly baseRevision?: Revision | undefined
  /**
   * Prefix prepended to the deterministic session slug when naming jj
   * workspaces and their directories. Must match `/^[A-Za-z0-9][A-Za-z0-9_-]{0,31}$/`.
   * Default {@link defaultWorkspacePrefix} (`"smthrs-ws-"`).
   */
  readonly workspacePrefix?: string | undefined
  /**
   * Host environment scrubbed through `ChildProcessEnvironment.make` to build
   * each spawned command's base environment. Only the bootstrap allowlist
   * (`PATH`, `HOME`, `USER`, `LANG`, `TERM`, `TMPDIR`, `SHELL`, `LC_*`) minus
   * credential-shaped names survives; `spawnOptions.env` is overlaid on top.
   *
   * Never read ambiently from `process.env`, keeping this module 100%
   * browser/Worker bundleable. A Node/Bun composition passes `env: process.env`;
   * omitting it starts commands with an empty base environment (fail-closed).
   */
  readonly env?: Readonly<Record<string, string | undefined>> | undefined
  /**
   * Whether each workspace gets a private, lane-local `.git` view borrowing
   * objects read-only from the repository's shared git store via
   * `objects/info/alternates` with detached `HEAD` at the pinned base.
   *
   * Default `true`: enables stock `Sandbox.run` and `SandboxMerge.Apply`
   * (including binary patches) and lane-local `git` commands without mutating
   * the host repository's refs or index. Set `false` for a jj-only workspace.
   */
  readonly git?: boolean | undefined
  /** Leave workspaces across scope closure until explicit `destroy`. Default `"ephemeral"`. */
  readonly persistence?: "ephemeral" | "sticky" | undefined
  /**
   * Receives every teardown step failure during scope closure.
   * Default: one `Effect.logWarning` per failure. A `kill` failure always dies
   * after reporting so a potentially surviving process is never masked.
   */
  readonly onTeardownFailure?: ((failure: TeardownFailure) => Effect.Effect<void>) | undefined
}

/** Lane bookkeeping directories excluded when mirroring a forked working tree. */
const reservedEntries: ReadonlySet<string> = new Set([".jj", ".git"])

/** `JjError` codes proving `workspaceAdd` failed before creating a new workspace owned by this call. */
const preCreationJjCodes: ReadonlySet<JjError["code"]> = new Set([
  "not_installed",
  "unsupported_version",
  "conflict",
  "invalid_ref"
])

const isPreCreationFailure = (cause: Cause.Cause<JjFailure | PlatformError.PlatformError>): boolean =>
  !Cause.hasInterrupts(cause) &&
  !Cause.hasDies(cause) &&
  Option.exists(
    Cause.findErrorOption(cause),
    (error) => isJjError(error) ? preCreationJjCodes.has(error.code) : error._tag !== "PlatformError"
  )

const jjFailure = (operation: string) => (cause: JjFailure | PlatformError.PlatformError): ProviderError => {
  if (isJjError(cause)) {
    const code: ProviderError["code"] =
      cause.code === "not_installed" || cause.code === "unsupported_version" || cause.code === "stale_workspace"
        ? "unavailable"
        : cause.code === "invalid_ref" || cause.code === "conflict"
        ? "spawn_error"
        : "unknown"
    return new ProviderError({ code, message: `${operation}: ${cause.message}`, cause })
  }
  return providerFailure("unavailable", operation)(cause)
}

const confineWorkdir = (
  path: Path.Path,
  workspacesRoot: string,
  workspaceName: string
): Effect.Effect<{ readonly root: string; readonly workdir: string }, ProviderError> => {
  const root = path.resolve(workspacesRoot)
  const workdir = path.resolve(root, workspaceName)
  const rel = path.relative(root, workdir)
  if (rel !== workspaceName) {
    return Effect.fail(
      new ProviderError({
        code: "spawn_error",
        message: `jj workspace path ${workdir} escapes workspacesRoot ${root}`
      })
    )
  }
  return Effect.succeed({ root, workdir })
}

interface Lane {
  released: boolean
  readonly activeHandles: Set<ChildProcessHandle>
}

interface ForkParent {
  readonly workdir: string
  readonly base: string | undefined
}

/**
 * Builds a sandbox provider whose machines are isolated Jujutsu workspaces on
 * this host.
 *
 * `acquire` creates one deterministic jj workspace per session key under
 * `options.workspacesRoot` via `jj.workspaceAdd(name, path, base)` and serves
 * the `Sandbox.Session` contract from it. Unless `git` is `false`, each lane
 * also gets a private, lane-local `.git` view whose `objects/info/alternates`
 * borrows read-only objects from the repository's shared git store and whose
 * detached `HEAD` and index are pinned at `base`: stock `Sandbox.run` and
 * `SandboxMerge.Apply` then work unchanged (including binary patches), while
 * lane-local `git` commands never mutate host refs or objects.
 *
 * Acquisition refuses non-contained spawners before touching `fs` or `jj`,
 * rejects untrusted `.jj/workspace-config.toml` files, serializes `jj`
 * workspace mutations through an internal semaphore, and rolls back any partial
 * workspace immediately on failure or interruption. Scope release kills all
 * active child processes first, then forgets the jj workspace and removes its
 * directory (or retains it in `"sticky"` mode until explicit, idempotent
 * `destroy`), reporting every step failure without masking.
 *
 * Like `DirectorySandbox`, this is a trusted local workspace boundary, **not a
 * security boundary**: host processes run with the host's network and no
 * provider-owned resource ceilings.
 *
 * @category constructors
 * @since 1.0.0
 */
export const make = (options: JjWorkspaceSandboxOptions): Provider => {
  if (
    /[\0\r\n]/.test(options.workspacesRoot) ||
    !absolutePathPattern.test(options.workspacesRoot) ||
    hasVcsMetadataSegment(options.workspacesRoot)
  ) {
    throw new TypeError(
      `jj-workspace-sandbox: workspacesRoot must be an absolute path without control bytes or VCS metadata segments, got ${
        JSON.stringify(options.workspacesRoot)
      }`
    )
  }
  refuseNetworkPolicy("jj-workspace-sandbox", options.network)
  refuseResourceLimits(
    "jj-workspace-sandbox",
    options.limits,
    ["cpus", "memoryMib", "timeoutSecs"],
    "commands run as host processes under no provider-owned ceiling"
  )
  const gitEnabled = options.git !== false
  if (options.baseRevision !== undefined) {
    if (gitEnabled && !isMaterialFullCommitId(options.baseRevision)) {
      throw new TypeError(
        `jj-workspace-sandbox: baseRevision must be a non-zero full commit id when git is enabled, got ${
          JSON.stringify(options.baseRevision)
        }`
      )
    }
    if (!gitEnabled && !revisionShapePattern.test(options.baseRevision)) {
      throw new TypeError(
        `jj-workspace-sandbox: baseRevision must be @, @-, a commit id, or a change id, got ${
          JSON.stringify(options.baseRevision)
        }`
      )
    }
  }
  const prefix = validatePrefix(options.workspacePrefix ?? defaultWorkspacePrefix)
  const hostEnv = options.env ?? {}
  const sticky = options.persistence === "sticky"
  const report = options.onTeardownFailure ??
    ((failed: TeardownFailure) =>
      Effect.logWarning("jj workspace sandbox teardown failed", {
        step: failed.step,
        workspace: failed.workspace,
        workdir: failed.workdir,
        cause: failed.cause
      }))

  // Serializes jj workspace mutations within this provider so concurrent
  // acquire/release/destroy calls never race on the repository op-log even
  // when an injected Jj implementation lacks its own internal lock.
  const jjGate = Semaphore.makeUnsafe(1)
  // Tracks active in-process lanes per workspace name: enforces single-holder
  // exclusivity in ephemeral mode and lets sticky `destroy` stop live children.
  const liveLanes = new Map<string, Set<Lane>>()

  const untrackLane = (workspaceName: string, lane: Lane): void => {
    const group = liveLanes.get(workspaceName)
    if (group === undefined) return
    group.delete(lane)
    if (group.size === 0) liveLanes.delete(workspaceName)
  }

  const deliver = (handle: ChildProcessHandle, signal: ChildProcess.Signal): Effect.Effect<void, ProviderError> =>
    handle.kill({ killSignal: signal }).pipe(
      Effect.mapError(providerFailure("unknown", `the signal ${signal} could not be delivered`))
    )

  const killHandles = (
    handles: Iterable<ChildProcessHandle>,
    session: string,
    workspace: string,
    workdir: string
  ): Effect.Effect<Array<TeardownFailure>> =>
    Effect.gen(function*() {
      const failures: Array<TeardownFailure> = []
      for (const handle of handles) {
        const exit = yield* Effect.exit(deliver(handle, "SIGTERM"))
        if (Exit.isFailure(exit)) {
          failures.push({ step: "kill", session, workspace, workdir, cause: Cause.squash(exit.cause) })
        }
      }
      return failures
    })

  const teardownLane = (
    session: string,
    workspaceName: string,
    workdir: string,
    lane: Lane,
    shouldRemove: boolean
  ): Effect.Effect<void> =>
    Effect.suspend(() => {
      if (lane.released) return Effect.void
      lane.released = true
      const pending = Array.from(lane.activeHandles)
      lane.activeHandles.clear()
      return Effect.gen(function*() {
        const failures = yield* killHandles(pending, session, workspaceName, workdir)
        if (shouldRemove) {
          yield* jjGate.withPermit(
            Effect.uninterruptible(
              Effect.gen(function*() {
                const forgetExit = yield* Effect.exit(options.jj.workspaceForget(workspaceName))
                if (Exit.isFailure(forgetExit)) {
                  failures.push({
                    step: "forget",
                    session,
                    workspace: workspaceName,
                    workdir,
                    cause: Cause.squash(forgetExit.cause)
                  })
                }
                const removeExit = yield* Effect.exit(
                  options.fs.remove(workdir, { recursive: true, force: true })
                )
                if (Exit.isFailure(removeExit)) {
                  failures.push({
                    step: "remove",
                    session,
                    workspace: workspaceName,
                    workdir,
                    cause: Cause.squash(removeExit.cause)
                  })
                }
              })
            )
          )
        }
        yield* Effect.forEach(failures, report, { discard: true })
        if (failures.some((failed) => failed.step === "kill")) {
          // A command that may have outlived its workspace is a containment
          // violation and must fail release rather than be masked.
          return yield* Effect.die(
            new ProviderError({
              code: "unknown",
              message: `jj workspace ${workspaceName} could not stop all active processes during release`,
              cause: failures
            })
          )
        }
      }).pipe(Effect.ensuring(Effect.sync(() => untrackLane(workspaceName, lane))))
    })

  const rollbackPartialAdd = (
    session: string,
    workspaceName: string,
    workdir: string,
    cause: Cause.Cause<JjFailure | PlatformError.PlatformError>
  ): Effect.Effect<void> =>
    Effect.uninterruptible(
      Effect.gen(function*() {
        const failures: Array<TeardownFailure> = []
        if (isPreCreationFailure(cause)) {
          const present = yield* options.fs.exists(workdir).pipe(
            Effect.catch((error) => {
              failures.push({ step: "remove", session, workspace: workspaceName, workdir, cause: error })
              return Effect.succeed(false)
            })
          )
          if (present) {
            const removeExit = yield* Effect.exit(options.fs.remove(workdir, { recursive: true, force: true }))
            if (Exit.isFailure(removeExit)) {
              failures.push({
                step: "remove",
                session,
                workspace: workspaceName,
                workdir,
                cause: Cause.squash(removeExit.cause)
              })
            }
          }
        } else {
          const forgetExit = yield* Effect.exit(options.jj.workspaceForget(workspaceName))
          if (Exit.isFailure(forgetExit)) {
            failures.push({
              step: "forget",
              session,
              workspace: workspaceName,
              workdir,
              cause: Cause.squash(forgetExit.cause)
            })
          }
          const removeExit = yield* Effect.exit(options.fs.remove(workdir, { recursive: true, force: true }))
          if (Exit.isFailure(removeExit)) {
            failures.push({
              step: "remove",
              session,
              workspace: workspaceName,
              workdir,
              cause: Cause.squash(removeExit.cause)
            })
          }
        }
        yield* Effect.forEach(failures, report, { discard: true })
      })
    )

  /**
   * Refuses a workspace holding an unmigrated `.jj/workspace-config.toml`,
   * which jj would import into its trusted config store on the next command.
   */
  const checkWorkspaceConfig = (workdir: string): Effect.Effect<void, ProviderError> =>
    Effect.gen(function*() {
      const configPath = options.path.join(workdir, ".jj", "workspace-config.toml")
      const hasLegacyConfig = yield* options.fs.exists(configPath)
      if (!hasLegacyConfig) return
      const hasMigratedId = yield* options.fs.exists(options.path.join(workdir, ".jj", "workspace-config-id"))
      if (!hasMigratedId) {
        return yield* new ProviderError({
          code: "unavailable",
          message: `${configPath} is not in jj's trusted store; refusing to use workspace`
        })
      }
    }).pipe(
      Effect.mapError(providerFailure("unavailable", `jj workspace ${workdir} config check failed`))
    )

  /** Runs `git read-tree HEAD` in `workdir` with a strictly scrubbed internal environment. */
  const runGitReadTree = (workdir: string): Effect.Effect<void, ProviderError> =>
    Effect.scoped(Effect.gen(function*() {
      const handle = yield* options.spawner.spawn(ChildProcess.make("git", ["read-tree", "HEAD"], {
        cwd: workdir,
        env: ChildProcessEnvironment.make(hostEnv, {
          GIT_CONFIG_NOSYSTEM: "1",
          GIT_CONFIG_GLOBAL: "/dev/null",
          JJ_CONFIG: "/dev/null"
        }),
        extendEnv: false
      })).pipe(
        Effect.mapError(providerFailure("unavailable", `\`git read-tree HEAD\` could not start in ${workdir}`))
      )
      const ran = yield* gather(handle, "git read-tree HEAD")
      if (ran.code !== 0) {
        return yield* new ProviderError({
          code: "unavailable",
          message: `\`git read-tree HEAD\` exited ${ran.code} in ${workdir}: ${
            ran.stderr.trim().split("\n").slice(-3).join("\n")
          }`
        })
      }
    }))

  /**
   * Installs a private, lane-local `.git` directory borrowing objects read-only
   * from the repository's shared git store via `objects/info/alternates`.
   *
   * Secondary jj workspaces have no `.git`. Borrowing objects via alternates
   * keeps refs, HEAD, index, and any newly hashed blobs strictly lane-local
   * (never mutating the host repository) while allowing stock `Sandbox.run` and
   * `SandboxMerge.Apply` to capture and land exact binary patches unchanged.
   */
  const setupGitView = (workdir: string, base: string): Effect.Effect<void, ProviderError> =>
    Effect.gen(function*() {
      const jjDir = options.path.join(workdir, ".jj")
      const pointer = (yield* options.fs.readFileString(options.path.join(jjDir, "repo"))).replace(/\r?\n$/, "")
      const storeDir = options.path.join(options.path.resolve(jjDir, pointer), "store")
      const target = (yield* options.fs.readFileString(options.path.join(storeDir, "git_target"))).replace(/\r?\n$/, "")
      const gitStore = options.path.resolve(storeDir, target)
      const objectsDir = yield* options.fs.realPath(options.path.join(gitStore, "objects"))
      if (/[\r\n\0]/.test(objectsDir)) {
        return yield* new ProviderError({
          code: "unavailable",
          message: `jj workspace ${workdir} resolved an invalid git object directory`
        })
      }
      const gitDir = options.path.join(workdir, ".git")
      // Non-recursive mkdir atomically refuses any pre-existing `.git` entry or symlink.
      yield* options.fs.makeDirectory(gitDir, { mode: 0o700 })
      yield* options.fs.makeDirectory(options.path.join(gitDir, "refs"), { recursive: true })
      yield* options.fs.makeDirectory(options.path.join(gitDir, "info"), { recursive: true })
      yield* options.fs.makeDirectory(options.path.join(gitDir, "objects", "info"), { recursive: true })
      const config = base.length === 64
        ? "[core]\n\trepositoryformatversion = 1\n\tbare = false\n[extensions]\n\tobjectformat = sha256\n"
        : "[core]\n\trepositoryformatversion = 0\n\tbare = false\n"
      yield* options.fs.writeFileString(options.path.join(gitDir, "HEAD"), `${base}\n`)
      yield* options.fs.writeFileString(options.path.join(gitDir, "config"), config)
      yield* options.fs.writeFileString(options.path.join(gitDir, "info", "exclude"), "/.jj/\n")
      yield* options.fs.writeFileString(options.path.join(gitDir, "objects", "info", "alternates"), `${objectsDir}\n`)
      // Defense-in-depth: even if a root `.gitignore` negates `/.jj/`, Git
      // descending into `.jj` still ignores every file inside it.
      yield* options.fs.writeFileString(options.path.join(jjDir, ".gitignore"), "*\n")
    }).pipe(
      Effect.mapError(providerFailure(
        "unavailable",
        `jj workspace ${workdir} has no git view: its repository must use jj's git backend (pass \`git: false\` for a jj-only workspace)`
      )),
      Effect.andThen(runGitReadTree(workdir))
    )

  /** Mirrors `from`'s working tree into `to` without `.jj`/`.git` bookkeeping or credential files. */
  const mirrorWorkingTree = (from: string, to: string): Effect.Effect<void, ProviderError> =>
    Effect.gen(function*() {
      const parentEntries = (yield* options.fs.readDirectory(from)).filter((entry) => !reservedEntries.has(entry))
      const childEntries = (yield* options.fs.readDirectory(to)).filter((entry) => !reservedEntries.has(entry))
      yield* Effect.forEach(
        childEntries,
        (entry) => options.fs.remove(options.path.join(to, entry), { recursive: true, force: true }),
        { discard: true }
      )
      yield* Effect.forEach(
        parentEntries,
        (entry) => options.fs.copy(options.path.join(from, entry), options.path.join(to, entry), { overwrite: true }),
        { discard: true }
      )
      yield* Effect.forEach(
        credentialFiles,
        (login) => options.fs.remove(options.path.join(to, login), { recursive: true, force: true }),
        { discard: true }
      )
    }).pipe(Effect.mapError(providerFailure("unavailable", `the jj workspace ${from} could not be forked`)))

  const snapshotBase = (): Effect.Effect<string, ProviderError> =>
    options.jj.snapshot().pipe(
      Effect.mapError(jjFailure("jj snapshot failed while pinning workspace base")),
      Effect.flatMap((snap) =>
        isMaterialFullCommitId(snap.commitId)
          ? Effect.succeed(snap.commitId)
          : Effect.fail(
            new ProviderError({
              code: "unavailable",
              message: `jj snapshot returned a non-material commit id ${JSON.stringify(snap.commitId)}`
            })
          )
      )
    )

  const open = (
    sessionKey: string,
    parent?: ForkParent,
    attachOnly = false
  ): Effect.Effect<Session, ProviderError, Scope> =>
    Effect.gen(function*() {
      if (!ContainedSpawner.isContained(options.spawner)) {
        return yield* Effect.fail(
          new ProviderError({
            code: "unavailable",
            message: "JjWorkspaceSandbox requires a contained ChildProcessSpawner with a platform lifecycle"
          })
        )
      }
      const workspaceName = workspaceNameOf(sessionKey, prefix)
      const { root, workdir } = yield* confineWorkdir(options.path, options.workspacesRoot, workspaceName)
      const lane: Lane = { released: false, activeHandles: new Set() }
      let setupCompleted = false

      const outcome = yield* Effect.uninterruptibleMask((restore) =>
        Effect.gen(function*() {
          if (!sticky && liveLanes.has(workspaceName)) {
            return yield* Effect.fail(
              new ProviderError({
                code: "unavailable",
                message: `jj workspace ${workspaceName} (${
                  JSON.stringify(sessionKey)
                }) is already held by this provider`
              })
            )
          }
          let group = liveLanes.get(workspaceName)
          if (group === undefined) {
            group = new Set()
            liveLanes.set(workspaceName, group)
          }
          group.add(lane)

          const provisionExit = yield* Effect.exit(
            attachOnly
              ? Effect.gen(function*() {
                const present = yield* restore(options.fs.exists(workdir)).pipe(
                  Effect.mapError(providerFailure("unavailable", `jj workspace lookup failed for ${workspaceName}`))
                )
                if (!present) {
                  return yield* Effect.fail(
                    new ProviderError({
                      code: "not_found",
                      message: `jj workspace ${workspaceName} (${workdir}) is absent`
                    })
                  )
                }
                yield* restore(checkWorkspaceConfig(workdir))
                return { created: false, resolvedBase: undefined as string | undefined }
              })
              : restore(
                jjGate.withPermit(
                  Effect.uninterruptibleMask((restoreInner) =>
                    Effect.gen(function*() {
                      yield* restoreInner(options.fs.makeDirectory(root, { recursive: true })).pipe(
                        Effect.mapError(
                          providerFailure("unavailable", `jj workspaces root ${root} could not be created`)
                        )
                      )
                      const existedBefore = yield* restoreInner(options.fs.exists(workdir)).pipe(
                        Effect.mapError(
                          providerFailure("unavailable", `jj workspace lookup failed for ${workspaceName}`)
                        )
                      )
                      if (existedBefore && sticky) {
                        yield* restoreInner(checkWorkspaceConfig(workdir))
                        return { created: false, resolvedBase: undefined as string | undefined }
                      }
                      const resolvedBase: string | undefined = parent?.base ??
                        options.baseRevision ??
                        (gitEnabled ? yield* restoreInner(snapshotBase()) : undefined)
                      const addExit = yield* Effect.exit(
                        restoreInner(
                          resolvedBase === undefined
                            ? options.jj.workspaceAdd(workspaceName, workdir)
                            : options.jj.workspaceAdd(workspaceName, workdir, resolvedBase)
                        )
                      )
                      if (Exit.isSuccess(addExit)) {
                        return { created: true, resolvedBase }
                      }
                      if (!existedBefore) {
                        yield* rollbackPartialAdd(sessionKey, workspaceName, workdir, addExit.cause)
                      }
                      return yield* Effect.failCause(addExit.cause).pipe(
                        Effect.mapError(jjFailure(`jj workspace ${workspaceName} could not be created`))
                      )
                    })
                  )
                )
              )
          )

          if (Exit.isFailure(provisionExit)) {
            untrackLane(workspaceName, lane)
            return yield* Effect.failCause(provisionExit.cause)
          }

          const result = provisionExit.value
          yield* Effect.addFinalizer(() =>
            teardownLane(sessionKey, workspaceName, workdir, lane, result.created && (!setupCompleted || !sticky))
          )
          return result
        })
      )

      if (outcome.created) {
        // Post-add setup rolls back immediately on failure or interruption even
        // if the caller catches the error inside a long-lived scope; `lane.released`
        // keeps the later scope finalizer idempotent.
        yield* Effect.gen(function*() {
          yield* checkWorkspaceConfig(workdir)
          if (gitEnabled) {
            yield* setupGitView(workdir, outcome.resolvedBase!)
          }
          if (parent !== undefined) {
            yield* mirrorWorkingTree(parent.workdir, workdir)
          }
        }).pipe(
          Effect.onExit((exit) =>
            Exit.isFailure(exit) ? teardownLane(sessionKey, workspaceName, workdir, lane, true) : Effect.void
          )
        )
      }

      setupCompleted = true
      const resolve = rootedAt(workdir)
      const started = new WeakMap<RemoteProcess, ChildProcessHandle>()
      const releasedError = () =>
        new ProviderError({
          code: "unavailable",
          message: `jj workspace ${workspaceName} (${workdir}) has been released`
        })

      const session: Session = {
        id: sessionKey,
        remoteId: workspaceName,
        workdir,
        spawn: Effect.fnUntraced(function*(command, spawnOptions) {
          if (lane.released) return yield* Effect.fail(releasedError())
          yield* checkEnvironmentNames(spawnOptions.env)
          const settings: ChildProcess.CommandOptions = {
            shell: "sh",
            cwd: resolve(spawnOptions.cwd ?? ""),
            env: ChildProcessEnvironment.make(hostEnv, spawnOptions.env),
            extendEnv: false,
            ...spawnOptions.stdin === undefined ? {} : { stdin: Stream.make(spawnOptions.stdin) }
          }
          const handle = yield* Effect.uninterruptibleMask((restore) =>
            Effect.gen(function*() {
              const child = yield* restore(options.spawner.spawn(ChildProcess.make(command, settings))).pipe(
                Effect.mapError(providerFailure("spawn_error", `\`${command}\` could not start`))
              )
              lane.activeHandles.add(child)
              yield* Effect.addFinalizer(() =>
                Effect.suspend(() =>
                  lane.activeHandles.delete(child) ? deliver(child, "SIGTERM").pipe(Effect.orDie) : Effect.void
                )
              )
              return child
            })
          )
          const remote = remoteProcessOf(handle, command)
          started.set(remote, handle)
          return remote
        }),
        readFile: (filePath) =>
          options.fs.readFile(filePath).pipe(
            Effect.mapError((error) =>
              error.reason._tag === "NotFound"
                ? new ProviderError({ code: "not_found", message: `the sandbox holds nothing at ${filePath}` })
                : providerFailure("unknown", `the sandbox could not read ${filePath}`)(error)
            )
          ),
        writeFile: (filePath, content) =>
          Effect.gen(function*() {
            yield* options.fs.makeDirectory(options.path.dirname(filePath), { recursive: true })
            yield* options.fs.writeFile(filePath, content)
          }).pipe(Effect.mapError(providerFailure("unknown", `the sandbox could not write ${filePath}`))),
        kill: (remote, signal) =>
          Effect.suspend(() => {
            const handle = started.get(remote)
            if (handle === undefined) {
              return Effect.fail(new ProviderError({ code: "unknown", message: "unrecognized process" }))
            }
            return deliver(handle, signal)
          }),
        ping: Effect.suspend(() =>
          lane.released
            ? Effect.fail(releasedError())
            : options.fs.exists(workdir).pipe(
              Effect.mapError(providerFailure("unavailable", `jj workspace ${workspaceName} could not be probed`)),
              Effect.flatMap((present) =>
                present
                  ? Effect.void
                  : Effect.fail(
                    new ProviderError({ code: "unavailable", message: `jj workspace ${workspaceName} is absent` })
                  )
              )
            )
        ),
        files: {
          writeFile: options.fs.writeFile,
          writeFileString: options.fs.writeFileString,
          chmod: options.fs.chmod,
          chown: options.fs.chown,
          exists: options.fs.exists,
          stat: options.fs.stat,
          readDirectory: options.fs.readDirectory,
          makeDirectory: options.fs.makeDirectory,
          remove: options.fs.remove,
          rename: options.fs.rename,
          realPath: options.fs.realPath,
          readLink: options.fs.readLink
        } satisfies Partial<FileSystem.FileSystem>,
        fork: (childKey) =>
          Effect.suspend(() =>
            lane.released ? Effect.fail(releasedError()) : open(childKey, { workdir, base: outcome.resolvedBase })
          )
      }
      return session
    })

  const stickyDestroy = (session: Pick<Session, "id" | "remoteId">): Effect.Effect<void, ProviderError> => {
    const workspaceName = workspaceNameOf(session.id, prefix)
    if (session.remoteId !== workspaceName) {
      return Effect.fail(
        new ProviderError({ code: "spawn_error", message: "jj workspace identity differs from key" })
      )
    }
    return Effect.flatMap(
      confineWorkdir(options.path, options.workspacesRoot, workspaceName),
      ({ workdir }) =>
        Effect.gen(function*() {
          const group = liveLanes.get(workspaceName)
          const pending: Array<ChildProcessHandle> = []
          if (group !== undefined) {
            for (const lane of group) {
              lane.released = true
              for (const handle of lane.activeHandles) pending.push(handle)
              lane.activeHandles.clear()
            }
            liveLanes.delete(workspaceName)
          }
          const failures = yield* killHandles(pending, session.id, workspaceName, workdir)
          yield* jjGate.withPermit(
            Effect.uninterruptible(
              Effect.gen(function*() {
                const forgetExit = yield* Effect.exit(
                  options.jj.workspaceForget(workspaceName).pipe(
                    Effect.catchIf(
                      (error) => isJjError(error) && error.code === "invalid_ref",
                      () => Effect.void
                    )
                  )
                )
                if (Exit.isFailure(forgetExit)) {
                  failures.push({
                    step: "forget",
                    session: session.id,
                    workspace: workspaceName,
                    workdir,
                    cause: Cause.squash(forgetExit.cause)
                  })
                }
                const removeExit = yield* Effect.exit(
                  options.fs.remove(workdir, { recursive: true, force: true })
                )
                if (Exit.isFailure(removeExit)) {
                  failures.push({
                    step: "remove",
                    session: session.id,
                    workspace: workspaceName,
                    workdir,
                    cause: Cause.squash(removeExit.cause)
                  })
                }
              })
            )
          )
          if (failures.length > 0) {
            return yield* Effect.fail(
              new ProviderError({
                code: failures.some((failed) => failed.step === "kill") ? "unknown" : "unavailable",
                message: `jj workspace ${workspaceName} could not be destroyed: ${
                  failures.map((failed) => failed.step).join(", ")
                } failed`,
                cause: failures
              })
            )
          }
        })
    )
  }

  return {
    acquire: (sessionKey) => open(sessionKey),
    ...sticky
      ? {
        retained: true as const,
        attach: (session: Pick<Session, "id" | "remoteId">) =>
          session.remoteId === workspaceNameOf(session.id, prefix)
            ? open(session.id, undefined, true)
            : Effect.fail(
              new ProviderError({ code: "spawn_error", message: "jj workspace identity differs from key" })
            ),
        destroy: stickyDestroy
      }
      : {}
  }
}
