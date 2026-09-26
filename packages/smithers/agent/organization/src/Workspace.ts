/**
 * Task workspaces in microVMs, and landing their changes on the host.
 *
 * Every agent-directed shell command, file edit, and test run of an
 * organization happens inside a machine; nothing runs on the host but `git`
 * plumbing the host itself drives. The lifecycle is:
 *
 * - {@link Service.prepare} seeds the machine's workspace with `git archive`
 *   of one commit of a host repository and records a guest baseline commit,
 *   so later changes are exactly what the agent did. It is idempotent: a
 *   workspace already seeded at that commit is reused, and one seeded at any
 *   other commit is refused rather than overwritten.
 * - {@link Service.session} reattaches the workspace machine for one role
 *   task; `RoleHost` binds shell and file tools to it. It refuses a machine
 *   that holds no seeded workspace (one lost with its host, or never
 *   prepared) rather than letting a role work in an empty machine.
 * - {@link Service.collect} returns the change as a binary-safe unified diff
 *   with per-file statistics.
 * - {@link Service.runChecks} seeds a **fresh** machine at the same commit,
 *   applies the patch, runs each configured check, and returns bounded
 *   stdout/stderr receipts; the fresh machine is removed afterwards.
 * - {@link Service.dispose} removes the workspace machine.
 * - {@link Service.applyChange} lands a patch on a named branch of the host
 *   repository with a temporary index and `commit-tree`, compare-and-set on
 *   the branch ref against the expected parent, with `Smithers-Run` and
 *   `Smithers-Principal` trailers. It never pushes, never touches the host's
 *   working tree or index, and refuses a branch that is checked out anywhere.
 *
 * Machines come from {@link Machines}; {@link microsandbox} builds them from
 * local Microsandbox microVMs, which is the only production backend. A
 * semaphore bounds how many machine operations run at once.
 *
 * @since 1.0.0
 */
import * as MicrosandboxSandbox from "@smthrs/sandbox/MicrosandboxSandbox"
import { ProviderError } from "@smthrs/sandbox/RemoteChildProcessSpawner"
import type { Session } from "@smthrs/sandbox/Sandbox"
import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as FileSystem from "effect/FileSystem"
import * as Layer from "effect/Layer"
import * as Path from "effect/Path"
import * as Schema from "effect/Schema"
import type * as Scope from "effect/Scope"
import * as Semaphore from "effect/Semaphore"
import type { ChildProcessSpawner } from "effect/unstable/process/ChildProcessSpawner"
import { sha256Hex } from "./internal/digest.ts"
import * as Process from "./internal/process.ts"

const pattern = (regex: RegExp, expected: string) => Schema.isPattern(regex, { expected })

/**
 * A workspace key: the durable name of one task's workspace machine.
 *
 * @category schemas
 * @since 1.0.0
 */
export const Key = Schema.String.check(
  pattern(/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$/, "a workspace key")
)

/**
 * A full commit id (SHA-1 or SHA-256).
 *
 * @category schemas
 * @since 1.0.0
 */
export const CommitId = Schema.String.check(pattern(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/, "a full commit id"))

/**
 * A seeded workspace: its key, the machine that holds it, the host commit it
 * was seeded from, and the guest baseline commit changes are measured from.
 *
 * @category schemas
 * @since 1.0.0
 */
export const Prepared = Schema.Struct({
  key: Key,
  remoteId: Schema.NonEmptyString,
  commit: CommitId,
  base: CommitId,
  workdir: Schema.NonEmptyString
})

/**
 * A seeded workspace.
 *
 * @category models
 * @since 1.0.0
 */
export type Prepared = typeof Prepared.Type

/**
 * One changed file. Counts are `null` for a binary file.
 *
 * @category schemas
 * @since 1.0.0
 */
export const FileStat = Schema.Struct({
  path: Schema.String,
  added: Schema.NullOr(Schema.Int),
  deleted: Schema.NullOr(Schema.Int)
})

/**
 * One changed file.
 *
 * @category models
 * @since 1.0.0
 */
export type FileStat = typeof FileStat.Type

/**
 * A workspace's change against the commit it was seeded from.
 *
 * @category schemas
 * @since 1.0.0
 */
export const Diff = Schema.Struct({
  commit: CommitId,
  patch: Schema.String,
  digest: Schema.String,
  bytes: Schema.Int,
  files: Schema.Array(FileStat),
  added: Schema.Int,
  deleted: Schema.Int
})

/**
 * A workspace's change.
 *
 * @category models
 * @since 1.0.0
 */
export type Diff = typeof Diff.Type

/**
 * The longest a single check may run, in milliseconds.
 *
 * @category constants
 * @since 1.0.0
 */
export const maxCheckTimeoutMs = 3_600_000

/**
 * One configured check: a name and the exact argv run in the workspace root.
 *
 * @category schemas
 * @since 1.0.0
 */
export const Check = Schema.Struct({
  name: Schema.NonEmptyString,
  argv: Schema.NonEmptyArray(Schema.String),
  timeoutMs: Schema.optionalKey(
    Schema.Int.check(Schema.isGreaterThan(0), Schema.isLessThanOrEqualTo(maxCheckTimeoutMs))
  )
})

/**
 * One configured check.
 *
 * @category models
 * @since 1.0.0
 */
export type Check = typeof Check.Type

/**
 * The head of one output stream, its full size, and whether it was cut.
 *
 * @category schemas
 * @since 1.0.0
 */
export const Output = Schema.Struct({ text: Schema.String, bytes: Schema.Int, truncated: Schema.Boolean })

/**
 * The head of one output stream.
 *
 * @category models
 * @since 1.0.0
 */
export type Output = typeof Output.Type

/**
 * What one check did. `exitCode` is `null` when it was stopped at its
 * deadline.
 *
 * @category schemas
 * @since 1.0.0
 */
export const CheckReceipt = Schema.Struct({
  name: Schema.NonEmptyString,
  argv: Schema.Array(Schema.String),
  exitCode: Schema.NullOr(Schema.Int),
  timedOut: Schema.Boolean,
  stdout: Output,
  stderr: Output,
  durationMs: Schema.Int
})

/**
 * What one check did.
 *
 * @category models
 * @since 1.0.0
 */
export type CheckReceipt = typeof CheckReceipt.Type

/**
 * Every check's receipt from one fresh machine. `passed` holds only when
 * every check exited 0.
 *
 * @category schemas
 * @since 1.0.0
 */
export const Checks = Schema.Struct({
  commit: CommitId,
  patchDigest: Schema.String,
  passed: Schema.Boolean,
  receipts: Schema.Array(CheckReceipt)
})

/**
 * Every check's receipt from one fresh machine.
 *
 * @category models
 * @since 1.0.0
 */
export type Checks = typeof Checks.Type

/**
 * A landed change: the branch, the new commit, and its parent. `created`
 * is `false` when the branch already held exactly this commit.
 *
 * @category schemas
 * @since 1.0.0
 */
export const Applied = Schema.Struct({
  branch: Schema.NonEmptyString,
  commit: CommitId,
  parent: CommitId,
  created: Schema.Boolean
})

/**
 * A landed change.
 *
 * @category models
 * @since 1.0.0
 */
export type Applied = typeof Applied.Type

/**
 * Stable workspace failure codes.
 *
 * @category schemas
 * @since 1.0.0
 */
export const WorkspaceErrorCode = Schema.Literals([
  "unavailable",
  "invalid-request",
  "not-a-commit",
  "archive-failed",
  "too-large",
  "seed-failed",
  "occupied",
  "unseeded",
  "diff-failed",
  "patch-does-not-apply",
  "moved-parent",
  "checked-out",
  "git-failed"
])

/**
 * A workspace failure code.
 *
 * @category models
 * @since 1.0.0
 */
export type WorkspaceErrorCode = typeof WorkspaceErrorCode.Type

/**
 * A workspace operation that could not complete.
 *
 * @category errors
 * @since 1.0.0
 */
export class WorkspaceError extends Schema.TaggedError<WorkspaceError>()(
  "@smthrs/organization/Workspace/WorkspaceError",
  { code: WorkspaceErrorCode, message: Schema.String }
) {}

/**
 * Where workspace machines come from.
 *
 * `workspace` creates or reattaches the long-lived machine for a key and
 * leaves it running when the scope closes; `fresh` returns a new machine
 * removed when the scope closes; `dispose` removes a workspace machine by
 * its remote id and succeeds when it is already gone.
 *
 * @category models
 * @since 1.0.0
 */
export interface Machines {
  readonly workspace: (key: string) => Effect.Effect<Session, ProviderError, Scope.Scope>
  readonly fresh: (key: string) => Effect.Effect<Session, ProviderError, Scope.Scope>
  readonly dispose: (remoteId: string) => Effect.Effect<void, ProviderError>
}

/**
 * How a Microsandbox-backed {@link Machines} boots its microVMs.
 *
 * @category models
 * @since 1.0.0
 */
export interface MicrosandboxOptions {
  /** The injected Microsandbox SDK (`import * as Microsandbox from "microsandbox"`). */
  readonly sdk: MicrosandboxSandbox.Sdk
  /** An image carrying `git`, `tar`, and `sh`, such as `node:26-bookworm`. */
  readonly image: string
  readonly cpus?: number | undefined
  readonly memoryMib?: number | undefined
  /** Guest networking. Default `false`: the machines boot without it. */
  readonly network?: boolean | undefined
  /** The installation these machines belong to; `reap` sweeps by it. */
  readonly owner: string
  /** The live host process holding them; `reap` asks whether it is alive. */
  readonly holder: string
  readonly labels?: Readonly<Record<string, string>> | undefined
  /** Upper bound on one machine's life. Default four hours. */
  readonly maxDurationSecs?: number | undefined
  /** Idle reclamation. Default one hour. */
  readonly idleTimeoutSecs?: number | undefined
  /** Image pull policy. Default `if-missing`. */
  readonly pullPolicy?: string | undefined
}

/**
 * The label naming the workspace key a sticky workspace machine holds. A
 * host reaping at startup reads it to keep the machines of runs that resume.
 *
 * @category constants
 * @since 1.0.0
 */
export const workspaceLabel = "smithers.workspace"

/**
 * Local Microsandbox microVMs as {@link Machines}: sticky workspace machines
 * that survive between steps and host restarts, each labelled with its
 * workspace key ({@link workspaceLabel}), ephemeral fresh ones, and a forced
 * removal for disposal. The provider refuses a hosted backend.
 *
 * @category constructors
 * @since 1.0.0
 */
export const microsandbox = (options: MicrosandboxOptions): Machines => {
  const shape = {
    sdk: options.sdk,
    image: options.image,
    cpus: options.cpus,
    memoryMib: options.memoryMib,
    disableNetwork: options.network !== true,
    owner: options.owner,
    holder: options.holder,
    labels: options.labels,
    maxDurationSecs: options.maxDurationSecs ?? 14_400,
    idleTimeoutSecs: options.idleTimeoutSecs ?? 3_600,
    pullPolicy: options.pullPolicy ?? "if-missing"
  }
  const ephemeral = MicrosandboxSandbox.make({ ...shape, persistence: "ephemeral" })
  return {
    workspace: (key) =>
      MicrosandboxSandbox.make({
        ...shape,
        labels: { ...options.labels, [workspaceLabel]: key },
        persistence: "sticky"
      })
        .acquire(key),
    fresh: (key) => ephemeral.acquire(key),
    dispose: (remoteId) =>
      Effect.tryPromise({
        try: async () => {
          const handle = await options.sdk.Sandbox.get(remoteId)
          await handle.destroy({ timeoutMs: 3_000, force: true })
        },
        catch: (cause) => cause
      }).pipe(
        Effect.catch((cause) =>
          Reflect.get(Object(cause), "code") === "sandboxNotFound"
            ? Effect.void
            : Effect.fail(
              new ProviderError({
                code: "unavailable",
                message: `microsandbox: ${remoteId} could not be removed`,
                cause
              })
            )
        )
      )
  }
}

/**
 * Byte bounds on what crosses the machine boundary.
 *
 * @category models
 * @since 1.0.0
 */
export interface Limits {
  /** Largest `git archive` of a seeded commit. */
  readonly archiveBytes: number
  /** Largest collected diff. */
  readonly diffBytes: number
  /** Most bytes of each check stream kept in a receipt. */
  readonly outputBytes: number
}

/**
 * Default {@link Limits}: 256 MiB archives, 8 MiB diffs, 64 KiB per stream.
 *
 * @category constants
 * @since 1.0.0
 */
export const defaultLimits: Limits = { archiveBytes: 268_435_456, diffBytes: 8_388_608, outputBytes: 65_536 }

/**
 * Who commits a landed change.
 *
 * @category models
 * @since 1.0.0
 */
export interface Identity {
  readonly name: string
  readonly email: string
}

/**
 * The default committer of landed changes.
 *
 * @category constants
 * @since 1.0.0
 */
export const defaultIdentity: Identity = { name: "Smithers Organization", email: "organization@smithers.invalid" }

/**
 * Options for {@link layer}.
 *
 * @category models
 * @since 1.0.0
 */
export interface Options {
  readonly machines: Machines
  /** Machine operations running at once, across every workspace. */
  readonly maxConcurrentVMs: number
  readonly limits?: Partial<Limits> | undefined
  readonly identity?: Identity | undefined
}

/**
 * A request to seed a workspace. `repoPath` is a trusted host path; `commit`
 * is any commit-ish, resolved to a full id on the host.
 *
 * @category models
 * @since 1.0.0
 */
export interface PrepareRequest {
  readonly key: string
  readonly repoPath: string
  readonly commit: string
}

/**
 * A request to run checks against a change in a fresh machine.
 *
 * @category models
 * @since 1.0.0
 */
export interface ChecksRequest {
  readonly key: string
  readonly repoPath: string
  readonly commit: string
  readonly patch: string
  readonly checks: ReadonlyArray<Check>
}

/**
 * A request to land a patch on a branch of a host repository.
 *
 * `parent` is the commit the patch was made against: a new branch starts
 * there, and an existing branch must still point at it. `at` fixes the
 * commit timestamps, so landing the same request twice yields the same
 * commit.
 *
 * @category models
 * @since 1.0.0
 */
export interface ApplyRequest {
  readonly repoPath: string
  readonly branch: string
  readonly parent: string
  readonly patch: string
  readonly message: string
  readonly runId: string
  readonly principal: string
  readonly at: number
}

/**
 * What a role task's session expects of its workspace.
 *
 * @category models
 * @since 1.0.0
 */
export interface SessionOptions {
  /** The host commit the workspace must be seeded from. */
  readonly commit?: string | undefined
}

/**
 * The workspace service.
 *
 * @category models
 * @since 1.0.0
 */
export interface Service {
  readonly prepare: (request: PrepareRequest) => Effect.Effect<Prepared, WorkspaceError>
  /**
   * Reattaches the workspace machine for `key` and holds a machine permit for
   * the scope. Fails `unseeded` when the machine holds no seeded workspace,
   * and `occupied` when it is seeded from another commit than `commit`.
   */
  readonly session: (key: string, options?: SessionOptions) => Effect.Effect<Session, WorkspaceError, Scope.Scope>
  readonly collect: (prepared: Pick<Prepared, "key" | "commit" | "base">) => Effect.Effect<Diff, WorkspaceError>
  readonly runChecks: (request: ChecksRequest) => Effect.Effect<Checks, WorkspaceError>
  readonly dispose: (prepared: Pick<Prepared, "remoteId">) => Effect.Effect<void, WorkspaceError>
  readonly applyChange: (request: ApplyRequest) => Effect.Effect<Applied, WorkspaceError>
}

/**
 * The workspace service tag.
 *
 * @category services
 * @since 1.0.0
 */
export const Workspace: Context.Service<Workspace, Service> = Context.Service("@smthrs/organization/Workspace")

/**
 * The workspace service.
 *
 * @category services
 * @since 1.0.0
 */
export type Workspace = Service

const fail = (code: WorkspaceErrorCode, message: string) => new WorkspaceError({ code, message })

const unavailable = (what: string) => (error: ProviderError) => fail("unavailable", `${what}: ${error.message}`)

const excerpt = (collected: Process.Collected): string => Process.text(collected).trim().slice(0, 2_000)

const seedName = ".smithers-seed.tar"
const patchName = ".smithers-change.patch"
const markerPath = ".git/smithers-base"
const guestGit = "git -c user.name=smithers -c user.email=smithers@localhost -c commit.gpgsign=false"

const lineSafe = /^[^\r\n\0]+$/

/**
 * Parses `git diff --numstat -z` output.
 *
 * @category conversions
 * @since 1.0.0
 */
export const parseNumstat = (output: string): ReadonlyArray<FileStat> => {
  const files: Array<FileStat> = []
  for (const record of output.split("\0")) {
    const match = /^(-|\d+)\t(-|\d+)\t([\s\S]+)$/.exec(record)
    if (match === null) continue
    files.push({
      path: match[3]!,
      added: match[1] === "-" ? null : Number(match[1]),
      deleted: match[2] === "-" ? null : Number(match[2])
    })
  }
  return files
}

/**
 * Builds the workspace service over host `git` and the given machines.
 *
 * @category constructors
 * @since 1.0.0
 */
export const make = (
  options: Options
): Effect.Effect<Service, never, ChildProcessSpawner | FileSystem.FileSystem | Path.Path> =>
  Effect.gen(function*() {
    const services = yield* Effect.context<ChildProcessSpawner | FileSystem.FileSystem | Path.Path>()
    const limits: Limits = { ...defaultLimits, ...options.limits }
    const identity = options.identity ?? defaultIdentity
    const permits = yield* Semaphore.make(options.maxConcurrentVMs)
    const machines = options.machines

    const host = (repo: string, args: ReadonlyArray<string>, limit: number, env?: Record<string, string>) =>
      Process.git(repo, args, { limit, env }).pipe(
        Effect.provide(services),
        Effect.mapError((error) => fail("git-failed", `git ${args[0]} could not run: ${error.message}`))
      )

    const resolveCommit = (repo: string, commit: string) =>
      Effect.gen(function*() {
        if (commit.startsWith("-") || !lineSafe.test(commit)) {
          return yield* fail("invalid-request", "the commit is not a commit-ish")
        }
        const resolved = yield* host(repo, [
          "rev-parse",
          "--verify",
          "--quiet",
          "--end-of-options",
          `${commit}^{commit}`
        ], 4_096)
        const id = Process.text(resolved.stdout).trim()
        if (resolved.exitCode !== 0 || !Schema.is(CommitId)(id)) {
          return yield* fail("not-a-commit", `${commit} is not a commit of the repository`)
        }
        return id
      })

    const archive = (repo: string, commit: string) =>
      Effect.gen(function*() {
        const tar = yield* host(repo, ["archive", "--format=tar", commit], limits.archiveBytes)
        if (tar.stdout.truncated) {
          return yield* fail("too-large", `the archive of ${commit} is over ${limits.archiveBytes} bytes`)
        }
        if (tar.exitCode !== 0) return yield* fail("archive-failed", `git archive failed: ${excerpt(tar.stderr)}`)
        return tar.stdout.bytes
      })

    const run = (session: Session, command: string, limit = 65_536) =>
      Process.guest(session, command, { limit }).pipe(Effect.mapError(unavailable("the machine did not run a command")))

    const seed = (session: Session, tar: Uint8Array) =>
      Effect.gen(function*() {
        yield* session.writeFile(`${session.workdir}/${seedName}`, tar).pipe(
          Effect.mapError(unavailable("the archive could not be copied into the machine"))
        )
        const extracted = yield* run(session, `tar -xf ${seedName} && rm -f ${seedName}`)
        if (extracted.exitCode !== 0) {
          return yield* fail("seed-failed", `the archive could not be extracted: ${excerpt(extracted.stderr)}`)
        }
      })

    const prepare = (request: PrepareRequest) =>
      Effect.gen(function*() {
        if (!Schema.is(Key)(request.key)) return yield* fail("invalid-request", "the workspace key is malformed")
        const commit = yield* resolveCommit(request.repoPath, request.commit)
        const tar = yield* archive(request.repoPath, commit)
        return yield* Effect.scoped(Effect.gen(function*() {
          const session = yield* machines.workspace(request.key).pipe(
            Effect.mapError(unavailable("the workspace machine could not be opened"))
          )
          const done = (base: string): Prepared => ({
            key: request.key,
            remoteId: session.remoteId,
            commit,
            base,
            workdir: session.workdir
          })
          const marker = yield* run(session, `cat ${markerPath} 2>/dev/null || true`)
          const [seededCommit = "", seededBase = ""] = Process.text(marker.stdout).trim().split(" ")
          if (seededCommit === commit && Schema.is(CommitId)(seededBase)) return done(seededBase)
          if (seededCommit.length > 0) {
            return yield* fail("occupied", `workspace ${request.key} is already seeded at another commit`)
          }
          // No baseline was recorded, so whatever is here is an interrupted
          // seed of this same key; start it over.
          const cleared = yield* run(session, "find . -mindepth 1 -maxdepth 1 -exec rm -rf {} +")
          if (cleared.exitCode !== 0) {
            return yield* fail("seed-failed", `an interrupted seed could not be cleared: ${excerpt(cleared.stderr)}`)
          }
          yield* seed(session, tar)
          const baseline = yield* run(
            session,
            [
              "git init -q",
              `${guestGit} add -A -f`,
              `${guestGit} commit -q --no-verify --allow-empty -m 'smithers base ${commit}'`,
              `base=$(git rev-parse HEAD)`,
              `printf '%s %s' ${commit} "$base" > ${markerPath}`,
              `printf '%s' "$base"`
            ].join(" && ")
          )
          const base = Process.text(baseline.stdout).trim()
          if (baseline.exitCode !== 0 || !Schema.is(CommitId)(base)) {
            return yield* fail("seed-failed", `the baseline commit could not be recorded: ${excerpt(baseline.stderr)}`)
          }
          return done(base)
        }))
      }).pipe(permits.withPermit)

    const seeded = (session: Session) =>
      Effect.map(run(session, `cat ${markerPath} 2>/dev/null || true`), (marker) => {
        const [commit = "", base = ""] = Process.text(marker.stdout).trim().split(" ")
        return Schema.is(CommitId)(commit) && Schema.is(CommitId)(base) ? { commit, base } : undefined
      })

    const session = (key: string, options: SessionOptions = {}) =>
      Effect.gen(function*() {
        yield* Effect.acquireRelease(permits.take(1), () => permits.release(1))
        const live = yield* machines.workspace(key).pipe(
          Effect.mapError(unavailable("the workspace machine could not be opened"))
        )
        const marker = yield* seeded(live)
        if (marker === undefined) {
          return yield* fail(
            "unseeded",
            `workspace ${key} holds no seeded checkout: its machine was lost or never prepared; start the request again`
          )
        }
        if (options.commit !== undefined && marker.commit !== options.commit) {
          return yield* fail("occupied", `workspace ${key} is seeded at ${marker.commit}, not ${options.commit}`)
        }
        return live
      })

    const collect = (prepared: Pick<Prepared, "key" | "commit" | "base">) =>
      Effect.scoped(Effect.gen(function*() {
        const live = yield* machines.workspace(prepared.key).pipe(
          Effect.mapError(unavailable("the workspace machine could not be opened"))
        )
        const staged = yield* run(live, `${guestGit} add -A`)
        if (staged.exitCode !== 0) {
          return yield* fail("diff-failed", `the change could not be staged: ${excerpt(staged.stderr)}`)
        }
        const range = ["--cached", "--no-color", "--no-ext-diff", "--no-renames", prepared.base, "--"]
        const patch = yield* run(live, `git diff --binary ${range.join(" ")}`, limits.diffBytes)
        if (patch.stdout.truncated) {
          return yield* fail("too-large", `the change is over ${limits.diffBytes} bytes`)
        }
        const numstat = yield* run(live, `git diff --numstat -z ${range.join(" ")}`, limits.diffBytes)
        if (patch.exitCode !== 0 || numstat.exitCode !== 0) {
          return yield* fail("diff-failed", `the change could not be read: ${excerpt(patch.stderr)}`)
        }
        const text = Process.text(patch.stdout)
        const files = parseNumstat(Process.text(numstat.stdout))
        return {
          commit: prepared.commit,
          patch: text,
          digest: sha256Hex(text),
          bytes: patch.stdout.total,
          files,
          added: files.reduce((sum, file) => sum + (file.added ?? 0), 0),
          deleted: files.reduce((sum, file) => sum + (file.deleted ?? 0), 0)
        }
      })).pipe(permits.withPermit)

    const output = (collected: Process.Collected): Output => ({
      text: Process.text(collected),
      bytes: collected.total,
      truncated: collected.truncated
    })

    const runChecks = (request: ChecksRequest) =>
      Effect.gen(function*() {
        if (!Schema.is(Key)(request.key)) return yield* fail("invalid-request", "the workspace key is malformed")
        const checks = yield* Schema.decodeUnknownEffect(Schema.Array(Check))(request.checks).pipe(
          Effect.mapError(() => fail("invalid-request", "a check is malformed"))
        )
        const commit = yield* resolveCommit(request.repoPath, request.commit)
        const tar = yield* archive(request.repoPath, commit)
        const fresh = `${request.key}/checks-${globalThis.crypto.randomUUID()}`
        return yield* Effect.scoped(Effect.gen(function*() {
          const session = yield* machines.fresh(fresh).pipe(
            Effect.mapError(unavailable("the check machine could not be opened"))
          )
          yield* seed(session, tar)
          if (request.patch.length > 0) {
            yield* session.writeFile(`${session.workdir}/${patchName}`, new TextEncoder().encode(request.patch)).pipe(
              Effect.mapError(unavailable("the patch could not be copied into the machine"))
            )
            const applied = yield* run(
              session,
              `git apply --binary --whitespace=nowarn ${patchName} && rm -f ${patchName}`
            )
            if (applied.exitCode !== 0) {
              return yield* fail("patch-does-not-apply", `the patch does not apply: ${excerpt(applied.stderr)}`)
            }
          }
          const receipts: Array<CheckReceipt> = []
          for (const check of checks) {
            const result = yield* Process.guest(session, Process.commandLine(check.argv), {
              limit: limits.outputBytes,
              timeoutMs: check.timeoutMs
            }).pipe(Effect.mapError(unavailable(`check ${check.name} did not run`)))
            receipts.push({
              name: check.name,
              argv: check.argv,
              exitCode: result.exitCode,
              timedOut: result.timedOut,
              stdout: output(result.stdout),
              stderr: output(result.stderr),
              durationMs: result.durationMs
            })
          }
          return {
            commit,
            patchDigest: sha256Hex(request.patch),
            passed: receipts.every((receipt) => receipt.exitCode === 0),
            receipts
          }
        }))
      }).pipe(permits.withPermit)

    const dispose = (prepared: Pick<Prepared, "remoteId">) =>
      machines.dispose(prepared.remoteId).pipe(
        Effect.mapError(unavailable("the workspace machine could not be removed")),
        permits.withPermit
      )

    const applyChange = (request: ApplyRequest) =>
      Effect.scoped(Effect.gen(function*() {
        const fs = yield* FileSystem.FileSystem
        const path = yield* Path.Path
        if (!Schema.is(CommitId)(request.parent)) {
          return yield* fail("invalid-request", "the parent is not a full commit id")
        }
        for (const [name, value] of [["runId", request.runId], ["principal", request.principal]] as const) {
          if (!lineSafe.test(value) || value.trim() !== value) {
            return yield* fail("invalid-request", `${name} is not one line of text`)
          }
        }
        if (request.message.trim().length === 0 || request.message.includes("\0")) {
          return yield* fail("invalid-request", "the commit message is empty")
        }
        if (!Number.isSafeInteger(request.at) || request.at < 0) {
          return yield* fail("invalid-request", "the commit time is not a non-negative integer instant")
        }
        const repo = request.repoPath
        if (request.branch.startsWith("-") || !lineSafe.test(request.branch)) {
          return yield* fail("invalid-request", "the branch name is not valid")
        }
        const format = yield* host(repo, ["check-ref-format", "--branch", request.branch], 4_096)
        if (format.exitCode !== 0 || Process.text(format.stdout).trim() !== request.branch) {
          return yield* fail("invalid-request", "the branch name is not valid")
        }
        const ref = `refs/heads/${request.branch}`
        const parent = yield* resolveCommit(repo, request.parent)
        if (parent !== request.parent) return yield* fail("not-a-commit", "the parent is not a commit")
        const current = yield* host(repo, ["rev-parse", "--verify", "--quiet", ref], 4_096)
        const tip = current.exitCode === 0 ? Process.text(current.stdout).trim() : undefined

        const scratch = yield* fs.makeTempDirectoryScoped({ prefix: "smithers-apply-" }).pipe(
          Effect.mapError(() => fail("git-failed", "a scratch directory could not be created"))
        )
        const patchFile = path.join(scratch, "change.patch")
        const messageFile = path.join(scratch, "message")
        const message =
          `${request.message.trimEnd()}\n\nSmithers-Run: ${request.runId}\nSmithers-Principal: ${request.principal}\n`
        yield* Effect.all([
          fs.writeFileString(patchFile, request.patch),
          fs.writeFileString(messageFile, message)
        ]).pipe(Effect.mapError(() => fail("git-failed", "the change could not be staged on disk")))
        const seconds = `@${Math.floor(request.at / 1000)} +0000`
        const env = {
          GIT_INDEX_FILE: path.join(scratch, "index"),
          GIT_AUTHOR_NAME: identity.name,
          GIT_AUTHOR_EMAIL: identity.email,
          GIT_AUTHOR_DATE: seconds,
          GIT_COMMITTER_NAME: identity.name,
          GIT_COMMITTER_EMAIL: identity.email,
          GIT_COMMITTER_DATE: seconds
        }
        const step = (args: ReadonlyArray<string>, code: WorkspaceErrorCode, what: string) =>
          Effect.gen(function*() {
            const result = yield* host(repo, args, 65_536, env)
            if (result.exitCode !== 0) return yield* fail(code, `${what}: ${excerpt(result.stderr)}`)
            return Process.text(result.stdout).trim()
          })
        const worktrees = yield* step(
          ["worktree", "list", "--porcelain"],
          "git-failed",
          "the worktrees could not be listed"
        )
        if (worktrees.split("\n").some((line) => line === `branch ${ref}`)) {
          return yield* fail(
            "checked-out",
            `${request.branch} is checked out; landing never moves a checked-out branch`
          )
        }
        yield* step(["read-tree", parent], "git-failed", "the parent tree could not be read")
        if (request.patch.length > 0) {
          yield* step(
            ["apply", "--cached", "--binary", "--whitespace=nowarn", patchFile],
            "patch-does-not-apply",
            "the patch does not apply to the parent"
          )
        }
        const tree = yield* step(["write-tree"], "git-failed", "the tree could not be written")
        const commit = yield* step(
          ["commit-tree", "--no-gpg-sign", tree, "-p", parent, "-F", messageFile],
          "git-failed",
          "the commit could not be written"
        )
        if (tip === commit) return { branch: request.branch, commit, parent, created: false }
        if (tip !== undefined && tip !== parent) {
          return yield* fail("moved-parent", `${request.branch} is at ${tip}, not at the expected parent ${parent}`)
        }
        const updated = yield* host(
          repo,
          ["update-ref", "-m", `smithers: land ${request.runId}`, ref, commit, tip ?? ""],
          65_536,
          env
        )
        if (updated.exitCode !== 0) {
          return yield* fail("moved-parent", `${request.branch} moved while landing: ${excerpt(updated.stderr)}`)
        }
        return { branch: request.branch, commit, parent, created: true }
      })).pipe(Effect.provide(services))

    return { prepare, session, collect, runChecks, dispose, applyChange }
  })

/**
 * Provides {@link Workspace} from {@link make}.
 *
 * @category layers
 * @since 1.0.0
 */
export const layer = (
  options: Options
): Layer.Layer<Workspace, never, ChildProcessSpawner | FileSystem.FileSystem | Path.Path> =>
  Layer.effect(Workspace)(make(options))
