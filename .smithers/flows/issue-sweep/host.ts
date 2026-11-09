/**
 * Runs operator bookkeeping on this machine's own process spawner.
 *
 * The flow's own spawner is capability-checked and confined: a child gets a
 * private HOME, reads nothing outside the checkout, and writes nothing outside
 * it. Operator bookkeeping needs the operator's state, so it runs here
 * instead: the issue claim (gh login, machine-wide throttle in ~/.cache), the
 * issue read (gh login), the account pools (~/.smithers/accounts), the jj
 * workspaces beside the checkout, and the push to GitHub. Code an agent wrote
 * never runs here: the agent runs inside its own Codex or Claude sandbox, and
 * the landing checks run inside `codex sandbox`.
 */
import * as NodeServices from "@effect/platform-node/NodeServices"
import { Fault } from "@smthrs/flow"
import { Unreachable } from "@smthrs/kernel"
import { Effect, Schema, Stream } from "effect"
import * as ChildProcess from "effect/process/ChildProcess"
import { ChildProcessSpawner } from "effect/process/ChildProcessSpawner"
import { homedir } from "node:os"

export class HostFailed extends Schema.TaggedError<HostFailed>()("issue-sweep/HostFailed", {
  message: Schema.String,
  code: Schema.optional(Schema.Literals(["unreachable", "refused", "stale_workspace"]))
}) {}
Fault.register("issue-sweep/HostFailed", { unreachable: "infra", refused: "dependency", stale_workspace: "dependency" })

/** Classify host diagnostics while retaining the host failure codec. */
export const hostFailed = (message: string) =>
  new HostFailed({
    message,
    code: Unreachable.classifyExit(message) === undefined ? "refused" : "unreachable"
  })

/** What one finished process printed, and how it exited. */
export interface Exited {
  readonly stdout: string
  readonly stderr: string
  readonly code: number
}

export interface RunOptions {
  readonly cwd?: string | undefined
  readonly env?: Record<string, string> | undefined
}

/** Names a stale jj workspace without changing its files. */
export const staleWorkspace = (
  args: ReadonlyArray<string>,
  exited: Exited,
  cwd?: string
): string | undefined => {
  if (exited.code === 0) return undefined
  if (!/seems to be a sibling of the working copy's operation|The working copy is stale/.test(exited.stderr)) {
    return undefined
  }
  return args[0] === "-R" && args[1] !== undefined ? args[1] : cwd
}

/** Runs a host command once; stale jj workspaces require deliberate recovery. */
export const run = (command: string, args: ReadonlyArray<string>, options: RunOptions = {}) => {
  // Landing serializes writes as `lockf -k -t 900 <lock> jj ...`.
  const jjAt = command === "jj" ? -1 : command === "lockf" && args[4] === "jj" ? 4 : undefined
  const jjArgs = jjAt === undefined ? undefined : args.slice(jjAt + 1)
  const argv = jjAt === undefined ? args : [
    ...args.slice(0, jjAt + 1),
    "--config",
    "snapshot.auto-update-stale=false",
    ...args.slice(jjAt + 1)
  ]
  return Effect.flatMap(once(command, argv, options), (exited) => {
    const stale = jjArgs === undefined ? undefined : staleWorkspace(jjArgs, exited, options.cwd ?? process.cwd())
    return stale === undefined
      ? Effect.succeed(exited)
      : Effect.fail(
        new HostFailed({
          code: "stale_workspace",
          message: `${exited.stderr}\nWorkspace ${stale}: commit or back up your files and recover deliberately.`
        })
      )
  })
}

const once = (command: string, args: ReadonlyArray<string>, options: RunOptions) =>
  Effect.scoped(Effect.gen(function*() {
    const spawner = yield* ChildProcessSpawner
    const handle = yield* spawner.spawn(ChildProcess.make(command, args, {
      ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
      ...(options.env === undefined ? {} : { env: options.env, extendEnv: true }),
      stdin: "ignore"
    }))
    const [stdout, stderr, code] = yield* Effect.all(
      [
        Stream.mkString(Stream.decodeText(handle.stdout)),
        Stream.mkString(Stream.decodeText(handle.stderr)),
        handle.exitCode
      ],
      { concurrency: "unbounded" }
    )
    return { stdout, stderr, code: Number(code) } satisfies Exited
  })).pipe(
    Effect.catchTag(
      "PlatformError",
      (cause) => Effect.fail(hostFailed(`${command}: ${cause.message}`))
    ),
    Effect.provide(NodeServices.layer)
  )

/** The last `lines` lines of `text`, for a failure message. */
export const tail = (text: string, lines = 5) => text.trim().split("\n").slice(-lines).join("\n")

/** Runs `command` and answers its stdout; a non-zero exit is {@link HostFailed}. */
export const output = (command: string, args: ReadonlyArray<string>, options: RunOptions = {}) =>
  Effect.flatMap(run(command, args, options), (exited) =>
    exited.code === 0
      ? Effect.succeed(exited.stdout)
      : Effect.fail(
        hostFailed(`${command} ${args[0] ?? ""}: exit ${exited.code}: ${tail(exited.stderr)}`)
      ))

/** The checkout every issue workspace branches from. */
export const repository = `${homedir()}/smithers`

/** Where the per-issue jj workspaces live: beside the checkout, never inside it. */
export const workspaces = `${homedir()}/smithers-sweep`

/** The jj workspace of one issue. */
export const workspaceOf = (issue: number) => `${workspaces}/issue-${issue}`

/** The jj workspace name of one issue. */
export const workspaceName = (issue: number) => `sweep-${issue}`

// Keep the original error outside `cause`: Fault.of reads the innermost cause.
Fault.register("issue-sweep/HostOutage", "infra")

/** Dispatches classified host connectivity failures as a keyed durable action. */
export const ridingOutages = <
  R,
  Success extends Schema.Constraint,
  Error extends Schema.Constraint & { readonly Type: { readonly message: string } }
>(effect: Effect.Effect<Success["Type"], Error["Type"], R>, options: {
  readonly name: string
  readonly idempotencyKey: string
  readonly implementationVersion: string
  readonly success: Success
  readonly error: Error
}) => {
  const Outage = Schema.Struct({
    _tag: Schema.Literal("issue-sweep/HostOutage"),
    message: Schema.String,
    original: options.error
  })
  const Failure = Schema.Union([Outage, options.error])
  return Fault.retryTransient<R, Success, typeof Failure>(
    effect.pipe(
      Effect.mapError((error) =>
        Unreachable.classifyExit(error.message) === undefined
          ? error
          : { _tag: "issue-sweep/HostOutage" as const, message: error.message, original: error }
      )
    ),
    { ...options, tier: "irreversible", error: Failure }
  ).pipe(
    Effect.mapError((error): Error["Type"] =>
      Schema.is(Outage)(error) ? (error as { readonly original: Error["Type"] }).original : error
    )
  )
}
