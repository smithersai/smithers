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
 * - A repository with an {@link Environment} that declares a `prepare`
 *   command is seeded from a **prepared base** instead: a machine seeded at
 *   a commit that ran the command (dependency installs, toolchain setup)
 *   with the network the command needs, captured as a disk snapshot. The
 *   base is keyed by the command, its network, and the content of the key
 *   paths (lockfiles) at the requested commit, so a later task at another
 *   commit with the same lockfile boots the same base and only syncs the
 *   source difference. Builders and checks then run with the environment's
 *   own network (default none).
 * - {@link Service.session} reattaches the workspace machine for one role
 *   task; `RoleHost` binds shell and file tools to it. It refuses a machine
 *   that holds no seeded workspace (one lost with its host, or never
 *   prepared) rather than letting a role work in an empty machine.
 * - {@link Service.collect} returns the change as a binary-safe unified diff
 *   with per-file statistics.
 * - {@link Service.runChecks} seeds a **fresh** machine at the same commit
 *   (from the prepared base when there is one), applies the patch, runs the
 *   environment's checks and then each requested check, and returns bounded
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
 * A domain a guest may reach: a host name, or `*.` and a suffix for every
 * name under it.
 *
 * @category schemas
 * @since 1.0.0
 */
export const Domain = Schema.String.check(
  pattern(
    /^(?:\*\.)?(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)+[A-Za-z][A-Za-z0-9-]{0,62}$/,
    "a domain name, or *. and a domain suffix"
  )
)

/**
 * A guest network: `none`, `all` (the provider's full outbound network), or
 * outbound HTTPS/HTTP and DNS to the listed domains only.
 *
 * @category schemas
 * @since 1.0.0
 */
export const Network = Schema.Union([Schema.Literals(["none", "all"]), Schema.NonEmptyArray(Domain)])

/**
 * A guest network.
 *
 * @category models
 * @since 1.0.0
 */
export type Network = typeof Network.Type

/**
 * A repository-relative path whose content keys a prepared base.
 *
 * @category schemas
 * @since 1.0.0
 */
export const KeyPath = Schema.String.check(
  pattern(/^(?!\/)(?!.*(?:^|\/)\.\.?(?:\/|$))[A-Za-z0-9._@+ /-]{1,512}$/, "a repository-relative path")
)

/**
 * The longest a prepare command may run, in milliseconds.
 *
 * @category constants
 * @since 1.0.0
 */
export const maxPrepareTimeoutMs = 7_200_000

/**
 * The default deadline of a prepare command: thirty minutes.
 *
 * @category constants
 * @since 1.0.0
 */
export const defaultPrepareTimeoutMs = 1_800_000

/**
 * How a repository's prepared base is made: the shell command run in the
 * seeded workspace root, the paths whose content keys the base, and the
 * network the command runs with.
 *
 * @category schemas
 * @since 1.0.0
 */
export const Prepare = Schema.Struct({
  run: Schema.NonEmptyString,
  key: Schema.NonEmptyArray(KeyPath),
  network: Network,
  timeoutMs: Schema.optionalKey(
    Schema.Int.check(Schema.isGreaterThan(0), Schema.isLessThanOrEqualTo(maxPrepareTimeoutMs))
  )
})

/**
 * How a repository's prepared base is made.
 *
 * @category models
 * @since 1.0.0
 */
export type Prepare = typeof Prepare.Type

/**
 * A repository's environment: an optional prepared base, the network its
 * workspace and check machines run with (default `none`), and the checks
 * every change to it runs before the requested ones.
 *
 * @category schemas
 * @since 1.0.0
 */
export const Environment = Schema.Struct({
  prepare: Schema.optionalKey(Prepare),
  network: Schema.optionalKey(Network),
  checks: Schema.optionalKey(Schema.Array(Check))
})

/**
 * A repository's environment.
 *
 * @category models
 * @since 1.0.0
 */
export type Environment = typeof Environment.Type

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
  "prepare-failed",
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
 * How a new machine boots: from a prepared base instead of the image, and
 * with which network. A reattached machine keeps how it was booted.
 *
 * @category models
 * @since 1.0.0
 */
export interface Boot {
  /** A base {@link Machines.bases} captured. Default: the image. */
  readonly base?: string | undefined
  /** Default: the machines' own default network. */
  readonly network?: Network | undefined
}

/**
 * Prepared bases: captured machine disks, by name.
 *
 * @category models
 * @since 1.0.0
 */
export interface Bases {
  /** What else a base depends on, such as the image; part of every base's key. */
  readonly identity: string
  readonly exists: (name: string) => Effect.Effect<boolean, ProviderError>
  /**
   * Stops the workspace machine `remoteId`, captures its disk as base `name`,
   * removes the machine, and drops the older bases of `family` beyond the
   * newest few, except those in `retain`: bases a machine is about to boot
   * from.
   */
  readonly capture: (
    remoteId: string,
    name: string,
    family: string,
    retain: ReadonlyArray<string>
  ) => Effect.Effect<void, ProviderError>
  /** Removes a base; one already gone is not an error. */
  readonly remove: (name: string) => Effect.Effect<void, ProviderError>
}

/**
 * Where workspace machines come from.
 *
 * `workspace` creates or reattaches the long-lived machine for a key and
 * leaves it running when the scope closes; `fresh` returns a new machine
 * removed when the scope closes; `dispose` removes a workspace machine by
 * its remote id and succeeds when it is already gone; `bases` holds the
 * prepared bases machines boot from.
 *
 * @category models
 * @since 1.0.0
 */
export interface Machines {
  readonly workspace: (key: string, boot?: Boot) => Effect.Effect<Session, ProviderError, Scope.Scope>
  readonly fresh: (key: string, boot?: Boot) => Effect.Effect<Session, ProviderError, Scope.Scope>
  readonly dispose: (remoteId: string) => Effect.Effect<void, ProviderError>
  readonly bases: Bases
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
  /** Root disk of an image-booted machine, in MiB. Default {@link defaultDiskMib}. */
  readonly diskMib?: number | undefined
  /** Guest networking when a boot names none. Default `false`: the machines boot without it. */
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
 * The default root disk of an image-booted machine: 32 GiB. The disk is
 * sparse, so only what a machine writes uses host space.
 *
 * @category constants
 * @since 1.0.0
 */
export const defaultDiskMib = 32_768

/** How many prepared bases of one repository are kept. */
const keptBases = 2

/**
 * The Microsandbox options a guest network boots with: no network, the
 * vendor's own, or deny-by-default egress that allows DNS to the gateway and
 * the listed domains.
 */
const networkOptions = (network: Network): {
  readonly disableNetwork?: boolean
  readonly networkPolicy?: MicrosandboxSandbox.NetworkPolicy
} => {
  if (network === "none") return { disableNetwork: true }
  if (network === "all") return {}
  return {
    networkPolicy: {
      defaultEgress: "deny",
      defaultIngress: "deny",
      rules: [
        {
          direction: "egress",
          destination: { kind: "group", group: "host" },
          protocols: ["udp", "tcp"],
          ports: [{ start: 53, end: 53 }],
          action: "allow"
        },
        ...network.map((domain) => ({
          direction: "egress" as const,
          destination: domain.startsWith("*.")
            ? { kind: "domainSuffix" as const, suffix: domain.slice(2) }
            : { kind: "domain" as const, domain },
          protocols: [],
          ports: [],
          action: "allow" as const
        }))
      ]
    }
  }
}

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
    cpus: options.cpus,
    memoryMib: options.memoryMib,
    rootDiskMib: options.diskMib ?? defaultDiskMib,
    owner: options.owner,
    holder: options.holder,
    maxDurationSecs: options.maxDurationSecs ?? 14_400,
    idleTimeoutSecs: options.idleTimeoutSecs ?? 3_600,
    pullPolicy: options.pullPolicy ?? "if-missing"
  }
  // Bases are this installation's own: another owner's never collide.
  const prefix = `smthrs-env-${sha256Hex(options.owner).slice(0, 8)}-`
  const booted = (boot: Boot | undefined) => ({
    ...shape,
    ...(boot?.base === undefined ? { image: options.image } : { snapshot: `${prefix}${boot.base}` }),
    ...networkOptions(boot?.network ?? (options.network === true ? "all" : "none"))
  })
  return {
    workspace: (key, boot) =>
      MicrosandboxSandbox.make({
        ...booted(boot),
        labels: { ...options.labels, [workspaceLabel]: key },
        persistence: "sticky"
      })
        .acquire(key),
    fresh: (key, boot) =>
      MicrosandboxSandbox.make({ ...booted(boot), labels: options.labels, persistence: "ephemeral" }).acquire(key),
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
      ),
    bases: {
      identity: `microsandbox ${options.image} disk ${shape.rootDiskMib}`,
      exists: (name) => MicrosandboxSandbox.hasSnapshot(options.sdk, `${prefix}${name}`),
      capture: (remoteId, name, family, retain) =>
        MicrosandboxSandbox.captureSnapshot({ sdk: options.sdk, machine: remoteId, name: `${prefix}${name}` }).pipe(
          Effect.andThen(
            MicrosandboxSandbox.pruneSnapshots(
              options.sdk,
              `${prefix}${family}-`,
              keptBases,
              retain.map((base) => `${prefix}${base}`)
            )
          ),
          Effect.asVoid
        ),
      remove: (name) => MicrosandboxSandbox.removeSnapshot(options.sdk, `${prefix}${name}`)
    }
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
  /** Each repository's environment, by its host path. A repository with none gets a bare checkout. */
  readonly environments?: Readonly<Record<string, Environment>> | undefined
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
  /**
   * A change applied over the seeded commit, as `collect` returns it: a
   * checker's own machine holds the change it judges. Preparing the same key
   * again leaves an applied patch as it is.
   */
  readonly patch?: string | undefined
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
const syncName = ".smithers-sync.patch"
const filesName = ".git/smithers-files"
const preparedPath = ".git/smithers-prepared"
const prepareLog = ".git/smithers-prepare.log"
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
    // One base is prepared at a time, so two tasks never prepare the same one.
    const baking = yield* Semaphore.make(1)
    // Bases known to hold their prepared tree, and bases a machine is about to
    // boot from, which pruning keeps.
    const verified = new Set<string>()
    const booting = new Map<string, number>()
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

    const environmentOf = (repo: string): Environment | undefined =>
      options.environments !== undefined && Object.hasOwn(options.environments, repo)
        ? options.environments[repo]
        : undefined

    /** The marker a seeded workspace records: the host commit and the guest baseline. */
    const readMarker = (session: Session, file: string) =>
      Effect.map(run(session, `cat ${file} 2>/dev/null || true`), (marker) => {
        const [commit = "", base = ""] = Process.text(marker.stdout).trim().split(" ")
        return { commit, base }
      })

    /**
     * Seeds an empty or interrupted image-booted workspace from the archive of
     * `commit` and records its baseline with every archived file tracked.
     */
    const seedFromArchive = (session: Session, repo: string, commit: string) =>
      Effect.gen(function*() {
        const tar = yield* archive(repo, commit)
        // No baseline was recorded, so whatever is here is an interrupted
        // seed of this same key; start it over.
        const cleared = yield* run(session, "find . -mindepth 1 -maxdepth 1 -exec rm -rf {} +")
        if (cleared.exitCode !== 0) {
          return yield* fail("seed-failed", `an interrupted seed could not be cleared: ${excerpt(cleared.stderr)}`)
        }
        yield* seed(session, tar)
        return yield* record(session, commit, markerPath, ["git init -q", `${guestGit} add -A -f`])
      })

    /** Commits the tree as the guest baseline and writes `commit base` to `file`. */
    const record = (session: Session, commit: string, file: string, stage: ReadonlyArray<string>) =>
      Effect.gen(function*() {
        const baseline = yield* run(
          session,
          [
            ...stage,
            `${guestGit} commit -q --no-verify --allow-empty -m 'smithers base ${commit}'`,
            `base=$(git rev-parse HEAD)`,
            `printf '%s %s' ${commit} "$base" > ${file}`,
            `printf '%s' "$base"`
          ].join(" && ")
        )
        const base = Process.text(baseline.stdout).trim()
        if (baseline.exitCode !== 0 || !Schema.is(CommitId)(base)) {
          return yield* fail("seed-failed", `the baseline commit could not be recorded: ${excerpt(baseline.stderr)}`)
        }
        return base
      })

    /** The name of the base `commit` of `repo` boots from under `prepare`, and the family it belongs to. */
    const baseOf = (repo: string, commit: string, prepare: Prepare) =>
      Effect.gen(function*() {
        const keys: Array<string> = []
        for (const path of prepare.key) {
          const found = yield* host(
            repo,
            ["rev-parse", "--verify", "--quiet", "--end-of-options", `${commit}:${path}`],
            4_096
          )
          keys.push(found.exitCode === 0 ? Process.text(found.stdout).trim() : "-")
        }
        const family = sha256Hex(`${machines.bases.identity}\0${repo}`).slice(0, 12)
        const name = `${family}-${
          sha256Hex(JSON.stringify(["base/v1", prepare.run, prepare.network, prepare.key, keys])).slice(0, 20)
        }`
        return { name, family }
      })

    /**
     * The prepared base `commit` of `repo` boots from, captured now when it
     * does not exist yet: the commit is seeded into a machine with the
     * command's network, the command runs, and the machine's disk becomes the
     * base.
     */
    const ensureBase = (repo: string, commit: string, prepare: Prepare) =>
      Effect.gen(function*() {
        const { family, name } = yield* baseOf(repo, commit, prepare)
        if (verified.has(name)) return trusted(name)
        return yield* baking.withPermit(Effect.gen(function*() {
          if (verified.has(name)) return trusted(name)
          const exists = yield* machines.bases.exists(name).pipe(
            Effect.mapError(unavailable("the prepared base could not be read"))
          )
          // A base this process did not capture is checked once before use; a
          // base without its prepared tree is removed and prepared again.
          if (exists && (yield* holdsPreparedTree(name))) return trusted(name)
          if (exists) yield* removeBase(name)
          // A capture that lost the prepared tree is prepared once more.
          for (let attempt = 0; attempt < 2; attempt++) {
            yield* bake(repo, commit, prepare, name, family)
            if (yield* holdsPreparedTree(name)) return trusted(name)
            yield* removeBase(name)
          }
          return yield* fail("prepare-failed", `the prepared base ${name} did not keep its prepared tree`)
        }))
      })

    /**
     * Marks a base as holding its tree and keeps it from pruning until the
     * caller releases it, in one step, so no preparation can prune it between.
     */
    const trusted = (name: string) => {
      verified.add(name)
      booting.set(name, (booting.get(name) ?? 0) + 1)
      return name
    }

    const removeBase = (name: string) =>
      machines.bases.remove(name).pipe(Effect.mapError(unavailable("a broken prepared base could not be removed")))

    /** Whether a machine booted from `name` holds the prepared tree's marker. */
    const holdsPreparedTree = (name: string) =>
      Effect.scoped(Effect.gen(function*() {
        const session = yield* machines.fresh(`bases/${name}/verify`, { base: name, network: "none" }).pipe(
          Effect.mapError(unavailable("the prepared base could not be booted"))
        )
        const prepared = yield* readMarker(session, preparedPath)
        return Schema.is(CommitId)(prepared.commit) && Schema.is(CommitId)(prepared.base)
      }))

    /**
     * Seeds `commit` into a machine of its own with the command's network,
     * runs the command, records the prepared tree, flushes it to disk, and
     * captures the disk as base `name`.
     */
    const bake = (repo: string, commit: string, prepare: Prepare, name: string, family: string) =>
      Effect.gen(function*() {
        const started = Date.now()
        const remoteId = yield* Effect.scoped(Effect.gen(function*() {
          // A key of its own per attempt: no other process's preparation of
          // the same base can reattach this machine.
          const session = yield* machines.workspace(`bases/${name}/${globalThis.crypto.randomUUID()}`, {
            network: prepare.network
          }).pipe(
            Effect.mapError(unavailable("the machine a base is prepared in could not be opened"))
          )
          // Removed on any failure, so a broken preparation is never captured.
          yield* Effect.addFinalizer((exit) =>
            exit._tag === "Success" ? Effect.void : Effect.ignore(machines.dispose(session.remoteId))
          )
          yield* seedFromArchive(session, repo, commit)
          const ran = yield* Process.guest(
            session,
            `(${prepare.run}) > ${prepareLog} 2>&1`,
            { limit: 4_096, timeoutMs: prepare.timeoutMs ?? defaultPrepareTimeoutMs }
          ).pipe(Effect.mapError(unavailable("the prepare command did not run")))
          if (ran.exitCode !== 0) {
            const tail = Process.text((yield* run(session, `tail -c 2000 ${prepareLog} 2>/dev/null || true`)).stdout)
              .trim()
            const reason = ran.timedOut
              ? "the prepare command timed out"
              : `the prepare command exited ${ran.exitCode}`
            return yield* fail("prepare-failed", tail === "" ? reason : `${reason}: ${tail}`)
          }
          // What the command left that the repository does not ignore is part
          // of the prepared tree, so it never shows up as a change.
          // A machine booted from the base is not yet a seeded workspace.
          yield* record(session, commit, preparedPath, [`rm -f ${markerPath}`, `${guestGit} add -A`])
          // The capture stops the machine; a stop that does not finish
          // gracefully loses what the guest has not written back yet.
          const flushed = yield* run(session, "sync")
          if (flushed.exitCode !== 0) {
            return yield* fail("seed-failed", `the prepared tree could not be flushed: ${excerpt(flushed.stderr)}`)
          }
          return session.remoteId
        }))
        yield* machines.bases.capture(remoteId, name, family, [...booting.keys()]).pipe(
          Effect.mapError(unavailable("the prepared base could not be captured"))
        )
        yield* Effect.logInfo(`prepared base ${name} of ${repo} in ${Date.now() - started} ms`)
      })

    /** Lets pruning remove a base {@link ensureBase} handed out again. */
    const release = (base: string | undefined) =>
      Effect.sync(() => {
        if (base === undefined) return
        const left = booting.get(base)! - 1
        if (left === 0) booting.delete(base)
        else booting.set(base, left)
      })

    /**
     * Opens a machine booted from `base` and returns it with the commit and
     * guest baseline the base was prepared at. A machine that holds no
     * prepared tree (one booted before the base existed) is replaced once.
     */
    const openFromBase = (
      open: (boot: Boot) => Effect.Effect<Session, ProviderError, Scope.Scope>,
      boot: Boot,
      replace: boolean
    ) =>
      Effect.gen(function*() {
        const opening = open(boot).pipe(Effect.mapError(unavailable("the machine could not be opened")))
        let session = yield* opening
        let prepared = yield* readMarker(session, preparedPath)
        if (replace && !Schema.is(CommitId)(prepared.base)) {
          yield* machines.dispose(session.remoteId).pipe(
            Effect.mapError(unavailable("a machine without its base could not be replaced"))
          )
          session = yield* opening
          prepared = yield* readMarker(session, preparedPath)
        }
        if (!Schema.is(CommitId)(prepared.commit) || !Schema.is(CommitId)(prepared.base)) {
          return yield* fail("seed-failed", "the machine booted from the prepared base holds no prepared tree")
        }
        return { session, prepared }
      })

    /**
     * Moves a base-booted tree from the commit it was prepared at to `commit`
     * and records `commit`'s baseline. The source difference is applied as a
     * patch; when it cannot be, the tracked files are replaced from the
     * archive. What the preparation installed stays in place either way.
     */
    const syncFromBase = (
      session: Session,
      repo: string,
      prepared: { readonly commit: string; readonly base: string },
      commit: string
    ) =>
      Effect.gen(function*() {
        const reset = yield* run(session, `git reset -q --hard ${prepared.base} && git clean -fdq`)
        if (reset.exitCode !== 0) {
          return yield* fail("seed-failed", `the prepared tree could not be restored: ${excerpt(reset.stderr)}`)
        }
        if (prepared.commit !== commit) {
          const diff = yield* host(
            repo,
            [
              "diff",
              "--binary",
              "--full-index",
              "--no-renames",
              "--no-color",
              "--no-ext-diff",
              prepared.commit,
              commit,
              "--"
            ],
            limits.archiveBytes
          )
          let synced = false
          if (diff.exitCode === 0 && !diff.stdout.truncated) {
            yield* session.writeFile(`${session.workdir}/${syncName}`, diff.stdout.bytes).pipe(
              Effect.mapError(unavailable("the source difference could not be copied into the machine"))
            )
            const applied = yield* run(
              session,
              `git apply --binary --whitespace=nowarn ${syncName}; code=$?; rm -f ${syncName}; exit $code`
            )
            synced = applied.exitCode === 0
          }
          if (!synced) {
            const removed = yield* run(session, "git ls-files -z | xargs -0 rm -f --")
            if (removed.exitCode !== 0) {
              return yield* fail("seed-failed", `the prepared tree could not be cleared: ${excerpt(removed.stderr)}`)
            }
            yield* seed(session, yield* archive(repo, commit))
          }
        }
        // Every file of the commit is tracked, even one the repository's own
        // ignore rules match; what the preparation installed stays ignored.
        const listed = yield* host(repo, ["ls-tree", "-r", "-z", "--full-tree", commit], limits.archiveBytes)
        if (listed.exitCode !== 0 || listed.stdout.truncated) {
          return yield* fail("archive-failed", `the files of ${commit} could not be listed: ${excerpt(listed.stderr)}`)
        }
        const files = Process.text(listed.stdout).split("\0").flatMap((entry) => {
          const match = /^\d+ blob [0-9a-f]+\t([\s\S]+)$/.exec(entry)
          return match === null ? [] : [`${match[1]!}\0`]
        }).join("")
        yield* session.writeFile(`${session.workdir}/${filesName}`, new TextEncoder().encode(files)).pipe(
          Effect.mapError(unavailable("the file list could not be copied into the machine"))
        )
        return yield* record(session, commit, markerPath, [
          `${guestGit} add -A`,
          `xargs -0 sh -c 'for f; do if [ -e "$f" ] || [ -L "$f" ]; then printf "%s\\0" "$f"; fi; done' _ < ${filesName} > ${filesName}.present`,
          `${guestGit} add -f --pathspec-from-file=${filesName}.present --pathspec-file-nul`,
          `rm -f ${filesName} ${filesName}.present`
        ])
      })

    /** Applies a collected change in a seeded checkout. */
    const applyPatch = (session: Session, patch: string) =>
      Effect.gen(function*() {
        if (patch.length === 0) return
        yield* session.writeFile(`${session.workdir}/${patchName}`, new TextEncoder().encode(patch)).pipe(
          Effect.mapError(unavailable("the patch could not be copied into the machine"))
        )
        const applied = yield* run(session, `git apply --binary --whitespace=nowarn ${patchName} && rm -f ${patchName}`)
        if (applied.exitCode !== 0) {
          return yield* fail("patch-does-not-apply", `the patch does not apply: ${excerpt(applied.stderr)}`)
        }
      })

    /**
     * A seeded workspace with `patch` applied once: a checkout that already
     * holds it (a prepare repeated after the patch went in) is left as it is.
     */
    const patched = (session: Session, seededBase: string, patch: string | undefined) =>
      Effect.gen(function*() {
        if (patch === undefined || patch.length === 0) return seededBase
        yield* session.writeFile(`${session.workdir}/${patchName}`, new TextEncoder().encode(patch)).pipe(
          Effect.mapError(unavailable("the patch could not be copied into the machine"))
        )
        const applied = yield* run(
          session,
          `if git apply --binary --reverse --check ${patchName} 2>/dev/null; then rm -f ${patchName}; else git apply --binary --whitespace=nowarn ${patchName} && rm -f ${patchName}; fi`
        )
        if (applied.exitCode !== 0) {
          return yield* fail("patch-does-not-apply", `the patch does not apply: ${excerpt(applied.stderr)}`)
        }
        return seededBase
      })

    const prepare = (request: PrepareRequest) =>
      Effect.gen(function*() {
        if (!Schema.is(Key)(request.key)) return yield* fail("invalid-request", "the workspace key is malformed")
        const commit = yield* resolveCommit(request.repoPath, request.commit)
        const environment = environmentOf(request.repoPath)
        const base = environment?.prepare === undefined
          ? undefined
          : yield* ensureBase(request.repoPath, commit, environment.prepare)
        yield* Effect.addFinalizer(() => release(base))
        const boot: Boot = { base, network: environment?.network ?? (base === undefined ? undefined : "none") }
        return yield* Effect.scoped(Effect.gen(function*() {
          const session = yield* machines.workspace(request.key, boot).pipe(
            Effect.mapError(unavailable("the workspace machine could not be opened"))
          )
          const done = (live: Session, seededBase: string): Prepared => ({
            key: request.key,
            remoteId: live.remoteId,
            commit,
            base: seededBase,
            workdir: live.workdir
          })
          const marker = yield* readMarker(session, markerPath)
          if (marker.commit === commit && Schema.is(CommitId)(marker.base)) {
            return done(session, yield* patched(session, marker.base, request.patch))
          }
          if (marker.commit.length > 0) {
            return yield* fail("occupied", `workspace ${request.key} is already seeded at another commit`)
          }
          if (base === undefined) {
            const seededBase = yield* seedFromArchive(session, request.repoPath, commit)
            return done(session, yield* patched(session, seededBase, request.patch))
          }
          const opened = yield* openFromBase((boot) => machines.workspace(request.key, boot), boot, true)
          const syncedBase = yield* syncFromBase(opened.session, request.repoPath, opened.prepared, commit)
          return done(opened.session, yield* patched(opened.session, syncedBase, request.patch))
        }))
      }).pipe(Effect.scoped, permits.withPermit)

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
        const requested = yield* Schema.decodeUnknownEffect(Schema.Array(Check))(request.checks).pipe(
          Effect.mapError(() => fail("invalid-request", "a check is malformed"))
        )
        const commit = yield* resolveCommit(request.repoPath, request.commit)
        const environment = environmentOf(request.repoPath)
        const checks = [...environment?.checks ?? [], ...requested]
        const base = environment?.prepare === undefined
          ? undefined
          : yield* ensureBase(request.repoPath, commit, environment.prepare)
        yield* Effect.addFinalizer(() => release(base))
        const boot: Boot = { base, network: environment?.network ?? (base === undefined ? undefined : "none") }
        const fresh = `${request.key}/checks-${globalThis.crypto.randomUUID()}`
        const tar = base === undefined ? yield* archive(request.repoPath, commit) : undefined
        return yield* Effect.scoped(Effect.gen(function*() {
          let session: Session
          if (tar === undefined) {
            const opened = yield* openFromBase((boot) => machines.fresh(fresh, boot), boot, false)
            session = opened.session
            yield* syncFromBase(session, request.repoPath, opened.prepared, commit)
          } else {
            session = yield* machines.fresh(fresh, boot).pipe(
              Effect.mapError(unavailable("the check machine could not be opened"))
            )
            yield* seed(session, tar)
          }
          yield* applyPatch(session, request.patch)
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
      }).pipe(Effect.scoped, permits.withPermit)

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
