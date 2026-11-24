/**
 * Deployment entry point for the hosted build cache.
 *
 * @since 0.1.0
 */

import { ambientEnvironment } from "@smthrs/build-cli/Environment"
import { type ChildProcess, spawn } from "node:child_process"
import { existsSync } from "node:fs"
import * as Fs from "node:fs/promises"
import * as NodeOs from "node:os"
import * as NodePath from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import {
  cacheOnlyVariable,
  protectedStages,
  sandboxWorkerId,
  stateSyncVariable,
  wrapperOwnedVariables
} from "../deployment.ts"
import { failureMessage } from "./failure-message.ts"
import { defaultStateDirectory, redactAlchemyState, type RedactAlchemyStateOptions } from "./redact-state.ts"
import {
  openRemoteState,
  previewRemoteState,
  refuseSharedState,
  remoteStateRequest,
  type RemoteStateSession,
  remoteStateTimeoutMs,
  stagePattern,
  type StateBucket,
  stateBucketFromEnvironment,
  stateObjectKey
} from "./remote-state.ts"
import { acquireStateOwnership, type StateOwnership } from "./state-ownership.ts"
import { resolveStateRoot } from "./state-root.ts"

const infraDirectory = NodePath.dirname(NodePath.dirname(fileURLToPath(import.meta.url)))
const alchemyCli = NodePath.join(infraDirectory, "node_modules", "alchemy", "bin", "cli.js")
const terminationSignals = ["SIGHUP", "SIGINT", "SIGTERM"] as const
const escalationDelayMs = 10_000

/** How the Alchemy command ended, as the exit code the wrapper reports for it. */
type CommandResult = { readonly exitCode: number }

const signalExitCode = (signal: NodeJS.Signals): number => {
  switch (signal) {
    case "SIGHUP":
      return 129
    case "SIGINT":
      return 130
    case "SIGTERM":
      return 143
    default:
      return 1
  }
}

const terminateProcessTree = (child: ChildProcess, signal: NodeJS.Signals): void => {
  const pid = child.pid
  if (pid === undefined) return
  try {
    if (process.platform === "win32") child.kill(signal)
    else process.kill(-pid, signal)
  } catch {
    try {
      child.kill(signal)
    } catch {
      // The command may already have exited between the close check and kill.
    }
  }
}

const processGroupExists = (pid: number): boolean => {
  try {
    process.kill(-pid, 0)
    return true
  } catch (error) {
    // Only ESRCH establishes that the group is gone. A refused probe must
    // not cancel escalation or allow redaction while descendants may run.
    return (error as NodeJS.ErrnoException).code !== "ESRCH"
  }
}

/**
 * Substitutions for the process the wrapper drives.
 *
 * Every field defaults to the production deployment. Naming them keeps the
 * wrapper's own guarantees testable without deploying anything: signal
 * forwarding, escalation, and redaction on every exit path.
 *
 * @category models
 * @since 0.1.0
 */
export interface DeployOptions {
  readonly cli?: string | undefined
  readonly cwd?: string | undefined
  /**
   * The stack's Alchemy state directory, which the wrapper owns for the whole
   * run. Each stage's working copy is the directory named after it inside.
   */
  readonly stateDirectory?: string | undefined
  readonly redact?: ((options: RedactAlchemyStateOptions) => Promise<number>) | undefined
  readonly escalationDelayMs?: number | undefined
  /** Where the durable copies of the stages' state live; defaults to the production R2 bucket. */
  readonly stateBucket?: ((signal?: AbortSignal) => Promise<StateBucket>) | undefined
  /** Deadline for each remote operation, including independent lock cleanup. */
  readonly remoteStateTimeoutMs?: number | undefined
}

/**
 * {@link DeployOptions} with every omission filled in.
 *
 * @category models
 * @since 0.1.0
 */
export interface ResolvedDeployOptions {
  readonly cli: string
  readonly cwd: string
  readonly stateDirectory: string
  readonly redact: (options: RedactAlchemyStateOptions) => Promise<number>
  readonly escalationDelayMs: number
  readonly stateBucket: (signal?: AbortSignal) => Promise<StateBucket>
  readonly remoteStateTimeoutMs: number
}

/**
 * Fills every omitted substitution from the production deployment: the pinned
 * Alchemy CLI, this directory, its state directory, real state redaction, and
 * the R2 bucket that holds the durable state.
 *
 * @category constructors
 * @since 0.1.0
 */
export const resolveDeployOptions = (options: DeployOptions): ResolvedDeployOptions => ({
  cli: options.cli ?? alchemyCli,
  cwd: options.cwd ?? infraDirectory,
  stateDirectory: options.stateDirectory ?? defaultStateDirectory,
  redact: options.redact ?? redactAlchemyState,
  escalationDelayMs: options.escalationDelayMs ?? escalationDelayMs,
  stateBucket: options.stateBucket ??
    ((signal) => stateBucketFromEnvironment(process.env, globalThis.fetch, { signal })),
  remoteStateTimeoutMs: options.remoteStateTimeoutMs ?? remoteStateTimeoutMs
})

/**
 * The stage a deployment that names none goes to: `dev_$USER`.
 *
 * A stage's resources and state are recorded under its name. Alchemy's own
 * default was `dev_$USER` and is now `live_$USER`, so a run that left the
 * choice to Alchemy would deploy a second development stack beside the one
 * `pnpm run deploy:dev` already made. The wrapper names the stage instead.
 *
 * @category constructors
 * @since 0.1.0
 */
export const developmentStage = (environment: NodeJS.ProcessEnv = ambientEnvironment()): string =>
  `dev_${environment["USER"] || environment["USERNAME"] || "unknown"}`

/** What one wrapper invocation acts on, and the arguments Alchemy gets. */
interface Invocation {
  readonly stage: string
  /** `--cache-only`: the stack leaves the sandbox service out. */
  readonly cacheOnly: boolean
  /** `--destroy`: Alchemy deletes every resource of the stage, then its object goes. */
  readonly destroy: boolean
  /** `--dry-run`: a plan, with no remote lock, no redaction, and nothing published. */
  readonly dryRun: boolean
  /** `--allow-destroy=<this stage>`: a destroy may delete a stage that is not throwaway. */
  readonly allowDestroy: boolean
  /** The Alchemy command line after the CLI's path. */
  readonly alchemyArgs: ReadonlyArray<string>
}

/** The wrapper's own flags, which never reach Alchemy as the caller wrote them. */
const wrapperFlags = new Set(["--", "--cache-only", "--destroy", "--dry-run"])

/**
 * Reads the wrapper's own flags and the stage out of the caller's arguments.
 *
 * pnpm forwards the `--` in `pnpm run deploy -- --yes` literally, and Alchemy
 * reads every argument after it as a positional, so it is dropped, as are the
 * wrapper's own flags. A command that names no stage gets `--stage dev_$USER`
 * appended, so the caller's own arguments keep their positions.
 *
 * Alchemy's `--env-file` is refused in either spelling. Alchemy reads that
 * file before the process environment, so it could override a variable the
 * wrapper sets for the run (`wrapperOwnedVariables`): the wrapper would pull,
 * guard and publish one stack while Alchemy applied another. A `.env` file in
 * this directory is read after the process environment and cannot.
 *
 * A dry run runs Alchemy's read-only `plan` (or `destroy --dry-run`), never a
 * `deploy` whose `--dry-run` could be switched off by a value after it, since
 * the wrapper skips the lock and publication for it. Any other spelling of
 * the flag is refused for the same reason.
 *
 * A stage in `protectedStages` is destroyed only with `--allow-destroy=<stage>`
 * naming it; a flag naming another stage, or no stage, does not count.
 *
 * @throws An `Error` for `--env-file`, a stage named twice, a `--stage` with no
 * value, a name `stagePattern` refuses, a `--dry-run=` or `--no-dry-run`
 * spelling, `--allow-destroy` without a stage, or `--destroy` of a protected
 * stage without `--allow-destroy=<stage>`.
 */
const invocationOf = (args: ReadonlyArray<string>): Invocation => {
  if (args.some((arg) => arg === "--env-file" || arg.startsWith("--env-file="))) {
    throw new Error(
      `--env-file is refused because Alchemy reads it before the process environment, so it could override ` +
        `${wrapperOwnedVariables.join(" and ")}, which the wrapper sets for every run; export its variables ` +
        `in the shell instead`
    )
  }
  const ambiguous = args.find((arg) => arg.startsWith("--dry-run=") || arg === "--no-dry-run")
  if (ambiguous !== undefined) throw new Error(`pass --dry-run alone, not ${ambiguous}`)
  if (args.includes("--allow-destroy")) throw new Error("name the stage: --allow-destroy=<stage>")
  const forwarded = args.filter((arg) => !wrapperFlags.has(arg) && !arg.startsWith("--allow-destroy="))
  const named: Array<string | undefined> = []
  forwarded.forEach((arg, index) => {
    if (arg === "--stage") named.push(forwarded[index + 1])
    else if (arg.startsWith("--stage=")) named.push(arg.slice("--stage=".length))
  })
  if (named.length > 1) throw new Error("name one --stage, not several")
  const stage = named.length === 0 ? developmentStage() : named[0]
  if (stage === undefined || !stagePattern.test(stage)) {
    throw new Error(
      `stage ${JSON.stringify(stage ?? "")} must be a letter or digit followed by letters, digits, "-" or "_"`
    )
  }
  const destroy = args.includes("--destroy")
  const dryRun = args.includes("--dry-run")
  const allowDestroy = args.includes(`--allow-destroy=${stage}`)
  if (destroy && !allowDestroy && protectedStages.includes(stage)) {
    throw new Error(
      `refusing to destroy stage ${stage}, which is protected; pass --allow-destroy=${stage} to destroy it`
    )
  }
  const command = destroy ? "destroy" : dryRun ? "plan" : "deploy"
  return {
    stage,
    cacheOnly: args.includes("--cache-only"),
    destroy,
    dryRun,
    allowDestroy,
    alchemyArgs: [
      command,
      "alchemy.run.ts",
      ...(named.length === 0 ? [...forwarded, "--stage", stage] : forwarded),
      ...(destroy && dryRun ? ["--dry-run"] : [])
    ]
  }
}

const runAlchemy = (
  command: { readonly cli: string; readonly cwd: string },
  invocation: Invocation,
  onSpawn: (child: ChildProcess) => void
): Promise<CommandResult> =>
  new Promise((resolve, reject) => {
    let child: ChildProcess
    try {
      child = spawn(process.execPath, [command.cli, ...invocation.alchemyArgs], {
        cwd: command.cwd,
        detached: process.platform !== "win32",
        // Set on every run, so a value the shell exported never decides
        // whether production keeps its sandbox service. Alchemy reads the
        // process environment before a `.env` file, and `--env-file`, which
        // it reads first, is refused above.
        env: { ...process.env, [stateSyncVariable]: "1", [cacheOnlyVariable]: invocation.cacheOnly ? "1" : "0" },
        stdio: "inherit"
      })
    } catch (error) {
      reject(error)
      return
    }
    let finished = false
    const finish = (complete: () => void): void => {
      if (finished) return
      finished = true
      complete()
    }
    onSpawn(child)
    child.once("error", (error) => finish(() => reject(error)))
    child.once("close", (code, signal) =>
      finish(() =>
        resolve({
          /* v8 ignore next -- Node reports a code or a signal on close, never neither, so the fallback is unreachable */
          exitCode: signal !== null ? signalExitCode(signal) : code ?? 1
        })
      ))
  })

/**
 * Runs Alchemy against state synced with R2, and always scrubs the deployed
 * stage's local state before returning.
 *
 * The stage comes from `--stage` (or `dev_$USER` when none is named) and must
 * match Alchemy's stage rule; a stage named twice or an unsafe name is refused
 * before anything else happens. Redaction walks only that stage's directory.
 *
 * The stage's local state directory is a working copy of the stage's own R2
 * object. Before Alchemy starts, the wrapper takes that object's lock and
 * pulls its snapshot over the directory; after redaction it publishes the
 * snapshot back, conditioned on the version it pulled, whether or not Alchemy
 * succeeded, because a failed run can still have created resources that only
 * its state records. No other stage's object is read, locked, or published.
 * A state directory that is relative or reached through a symbolic link, a
 * held remote lock, state still in the shared layout from before per-stage
 * objects, or any failure to reach R2 refuses the run before Alchemy starts,
 * and the linked directory is refused before anything is created or pulled
 * into its target. State that failed redaction is never published.
 *
 * `--dry-run` runs Alchemy's `plan`: it takes local ownership and pulls the
 * stage's object without its lock, then redacts and publishes nothing.
 * `--destroy` runs Alchemy's `destroy` through the same round trip as a
 * deployment, and once Alchemy has deleted the stage's state the push deletes
 * the stage's object. A stage in `protectedStages`, or one whose state records
 * a sandbox Worker, is destroyed only with `--allow-destroy=<stage>`.
 *
 * The wrapper owns the state directory from before Alchemy starts until
 * redaction has published its last file, so no other deployment or standalone
 * redaction can replace state under either of them; a second deployment of
 * the same state is refused. A termination signal that arrives while remote
 * state is pulled releases the remote lock and returns before Alchemy starts.
 * Termination signals are held while cleanup runs and are forwarded to the
 * complete detached Alchemy process group. After interruption, the group is
 * tracked until it is observed gone, even if its leader exits first. Surviving
 * members receive SIGKILL after a bounded grace period, before redaction and
 * return. Windows waits for the directly signalled child; ordinary command
 * completion does not wait out the grace period.
 *
 * @category commands
 * @since 0.1.0
 */
export const deploy = async (
  args: ReadonlyArray<string> = process.argv.slice(2),
  options: DeployOptions = {}
): Promise<number> => {
  const {
    cli,
    cwd,
    escalationDelayMs: escalationDelay,
    redact,
    remoteStateTimeoutMs: timeoutMs,
    stateBucket,
    stateDirectory
  } = resolveDeployOptions(
    options
  )
  const target = { cli, cwd }
  let invocation: Invocation
  let ownership: StateOwnership
  try {
    invocation = invocationOf(args)
    // A state directory reached through a symbolic link, in the root or an
    // ancestor, is refused before anything is created or pulled: the pull
    // would otherwise replace the link target's files, and redaction's own
    // refusal would come only after they were lost.
    await resolveStateRoot(stateDirectory)
    // Alchemy creates the state directory on first use; creating it here lets
    // ownership exist before Alchemy writes anything into it. Ownership is the
    // stack directory's, not the stage's: Alchemy's destroy deletes the stage
    // directory, and the ownership database must never be deleted while held.
    await Fs.mkdir(stateDirectory, { recursive: true })
    ownership = await acquireStateOwnership(stateDirectory)
  } catch (error) {
    process.stderr.write(`Alchemy deployment refused: ${failureMessage(error)}\n`)
    return 1
  }
  // Alchemy keeps a stage's state in `<stack state directory>/<stage>`, so that
  // directory is the stage's working copy of its own R2 object.
  const stageDirectory = NodePath.join(stateDirectory, invocation.stage)
  const initialization = new AbortController()
  let activeChild: ChildProcess | undefined
  let requestedSignal: NodeJS.Signals | undefined
  let escalationTimer: ReturnType<typeof setTimeout> | undefined

  const clearEscalation = (): void => {
    if (escalationTimer !== undefined) clearTimeout(escalationTimer)
    escalationTimer = undefined
  }
  const forward = (signal: NodeJS.Signals): void => {
    const child = activeChild
    if (child === undefined) return
    terminateProcessTree(child, signal)
    if (signal !== "SIGKILL") {
      clearEscalation()
      escalationTimer = setTimeout(() => terminateProcessTree(child, "SIGKILL"), escalationDelay)
    }
  }
  const waitForProcessGroup = async (): Promise<void> => {
    const pid = activeChild?.pid
    if (requestedSignal === undefined || process.platform === "win32" || pid === undefined) return
    while (processGroupExists(pid)) {
      await new Promise<void>((resolve) => setTimeout(resolve, 25))
    }
  }
  const handlers = new Map<NodeJS.Signals, () => void>()
  for (const signal of terminationSignals) {
    const handler = (): void => {
      if (requestedSignal === undefined) {
        requestedSignal = signal
        initialization.abort(new Error("remote state initialization cancelled"))
        forward(signal)
      } else {
        forward("SIGKILL")
      }
    }
    handlers.set(signal, handler)
    process.on(signal, handler)
  }
  const removeHandlers = (): void => {
    for (const [signal, handler] of handlers) process.off(signal, handler)
  }

  // The handlers are installed before the remote lock is taken: a signal's
  // default action during the pull would leave that lock in R2 for every
  // later deployment to trip over. A signal before Alchemy starts cancels it.
  let remote: RemoteStateSession | undefined
  try {
    const requestOptions = { signal: initialization.signal, timeoutMs }
    const bucket = await remoteStateRequest(
      "remote state initialization",
      (signal) => stateBucket(signal),
      requestOptions
    )
    await refuseSharedState(bucket, stateDirectory, invocation.stage, requestOptions)
    const stageState = { bucket, key: stateObjectKey(invocation.stage) }
    if (invocation.dryRun) {
      // A plan reads the stage's object to plan against durable state; it
      // writes no state, so it needs no lock and publishes nothing.
      await previewRemoteState(stageState, stageDirectory, requestOptions)
    } else {
      remote = await openRemoteState(stageState, stageDirectory, {
        host: NodeOs.hostname(),
        pid: process.pid,
        startedAt: new Date().toISOString()
      }, requestOptions)
    }
    // A stage whose state records a sandbox Worker serves more than a
    // throwaway cache. A cache-only program declares no sandbox Worker, so
    // Alchemy would plan the deletion of that one, and a destroy deletes it
    // with everything else, so a destroy needs the flag that names the stage.
    const hasSandbox = existsSync(NodePath.join(stageDirectory, `${sandboxWorkerId}.json`))
    if (hasSandbox && invocation.destroy && !invocation.allowDestroy) {
      throw new Error(
        `refusing to destroy stage ${invocation.stage}, whose state holds a sandbox Worker; pass ` +
          `--allow-destroy=${invocation.stage} to destroy it`
      )
    }
    if (hasSandbox && invocation.cacheOnly && !invocation.destroy) {
      throw new Error(
        `stage ${invocation.stage} has a sandbox Worker, which a --cache-only run would delete; deploy it without ` +
          `--cache-only, or destroy the stage`
      )
    }
  } catch (error) {
    try {
      await remote?.release()
    } finally {
      try {
        await ownership.release()
      } finally {
        removeHandlers()
      }
    }
    process.stderr.write(`Alchemy deployment refused: ${failureMessage(error)}\n`)
    return requestedSignal !== undefined && error === initialization.signal.reason ? signalExitCode(requestedSignal) : 1
  }

  let command: CommandResult | undefined
  let commandFailure: unknown
  let redactionFailure: unknown
  let publicationFailure: unknown
  try {
    try {
      // The handlers above are installed and the child is spawned in the
      // same synchronous run, so no signal can arrive before `onSpawn`.
      command = await runAlchemy(
        target,
        invocation,
        (child) => {
          activeChild = child
        }
      )
    } catch (error) {
      commandFailure = error
    }

    // The leader's close event says nothing about surviving descendants.
    // Keep the group handle and referenced escalation deadline until the
    // interrupted group is gone, including for a second termination signal.
    await waitForProcessGroup()
    activeChild = undefined
    clearEscalation()

    // A plan holds no session: it wrote no state, so there is nothing to
    // redact or publish.
    if (remote !== undefined) {
      try {
        // Only the deployed stage's directory: another stage's verifiers derive
        // from tokens this shell does not hold, and rewriting them would be
        // published as that stage's state.
        const redactedFiles = await redact({ directory: stageDirectory, ownership })
        process.stdout.write(`Redacted ${redactedFiles} Alchemy Worker state file(s).\n`)
      } catch (error) {
        redactionFailure = error
      }

      if (redactionFailure === undefined) {
        try {
          const published = await remote.push()
          process.stdout.write(`Remote Alchemy state ${published}.\n`)
        } catch (error) {
          publicationFailure = error
        }
      }
    }
  } finally {
    clearEscalation()
    try {
      await remote?.release()
    } catch (error) {
      publicationFailure ??= error
    } finally {
      try {
        await ownership.release()
      } finally {
        removeHandlers()
      }
    }
  }

  if (commandFailure !== undefined) {
    process.stderr.write(`Alchemy deployment failed: ${failureMessage(commandFailure)}\n`)
  }
  if (redactionFailure !== undefined) {
    process.stderr.write(`Alchemy state redaction failed: ${failureMessage(redactionFailure)}\n`)
  }
  if (publicationFailure !== undefined) {
    process.stderr.write(`Remote Alchemy state was not published: ${failureMessage(publicationFailure)}\n`)
  }
  if (command === undefined || redactionFailure !== undefined || publicationFailure !== undefined) return 1
  if (requestedSignal !== undefined) return signalExitCode(requestedSignal)
  return command.exitCode
}

const invokedPath = process.argv[1]
/* v8 ignore next 3 -- the process entry runs the pinned Alchemy CLI against the operator's own state; the suite drives every wrapper path through `deploy` with substitutes instead */
if (invokedPath !== undefined && import.meta.url === pathToFileURL(invokedPath).href) {
  process.exitCode = await deploy()
}
