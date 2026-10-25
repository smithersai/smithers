import { WebCrypto } from "@smthrs/crypto"
import { Action, FlowRuntime } from "@smthrs/flow"
import { SandboxCommand, SandboxTools } from "@smthrs/sandbox"
import { Config, type Duration, Effect, Layer, Option, Schema } from "effect"
import { COMMAND_LIMIT_SECONDS } from "../../src/features/sandbox/contract.ts"
import { MachineFailure, Machines } from "../branch/Machines.ts"
import { SandboxBranch } from "../branch/Sandboxes.ts"

// `sandbox/Command { target: { branch, ownerId }, call }` (docs/features/sandbox-tools.md#long-commands): one sandbox
// `run` command on a branch's machine, as `@smthrs/sandbox`'s `SandboxCommand` job, the library catalog's "Run commands
// on a ... sandbox" over `@smthrs/flow`'s `ExternalJob`.
//
//   start (wake the machine, start the command detached as the person's user, once per key)
//     ─▶ probe ─▶ park ─▶ probe ... (each probe waits for the exit until the next is due; no step holds the command)
//     ─▶ collect (its RunResult; the working copy is saved)        └ lost or past the deadline: cancel, then fail
//
// A step that asks (`run`) does the start, waiting reads and the collect itself when the command ends within its own
// timeout and the drive's budget: no job execution, no park, so the run that asked goes on at once. A command still
// running when the drive's budget ends goes on as the job, and the run parks.
//
// A command that runs for up to an hour (`COMMAND_LIMIT_SECONDS`; a deployment may lower it with
// `SANDBOX_COMMAND_MAX_SECONDS`) holds no step of the run that asked for it, so neither Cloudflare's 15-minute alarm limit
// nor a host that stops mid-command loses it: the next drive probes the same command and collects its result once. The TODO agent's `sandbox/run` tool (worker/flows/TodoAgent.ts) and a person's or the branch agent's
// `run` call (`sandbox/Call`, worker/flows/SandboxCall.ts) run their commands here. Each job runs where it was started
// from, and a host that resolves an execution's flow by its tag lists `Command.flows` (worker/ExecutionHost.ts).

/**
 * Whose command it is: the branch whose machine runs it, the person whose user runs it, and the tool call it is for,
 * whose command an attempt from before commands ran as jobs may have run as a tool call (`Machines.commands`).
 */
export const Target = Schema.Struct({ branch: SandboxBranch, ownerId: Schema.String, callId: Schema.String })
export type Target = typeof Target.Type

/**
 * `sandbox/Command`: a command of up to `COMMAND_LIMIT_SECONDS` on a branch's machine, started once, probed from a second
 * after it starts doubling to every 20 seconds, and collected. Its deadline is 20 minutes past the longest command,
 * from before the start's wake. A lost command is cancelled and fails `ExternalJobLost`, never started again
 * (`restarts` 0), so a command still runs at most once per call.
 */
export const Command = SandboxCommand.make("sandbox/Command", {
  target: Target,
  error: MachineFailure,
  maxTimeoutSeconds: COMMAND_LIMIT_SECONDS,
})

/**
 * A sandbox tool call whose `run` runs as a `sandbox/Command` job, so its `timeoutSeconds` goes up to `seconds` where a
 * tool call's stops at `SandboxTools.limits.maxTimeoutSeconds`: what `sandbox/Call` takes (up to the job's limit), and
 * what `POST /api/sandbox/calls` admits (up to the deployment's `SANDBOX_COMMAND_MAX_SECONDS`, src/features/sandbox/config.ts).
 * Every other tool is `SandboxTools`' own.
 */
export const ToolCall = (seconds: number) =>
  Schema.Union([
    SandboxCommand.Run(seconds),
    SandboxTools.Read,
    SandboxTools.Write,
    SandboxTools.List,
    SandboxTools.Status,
    SandboxTools.Diff,
  ])

/** The job's operations on `machines`: every operation reaches the branch's machine as the person's user. */
export const operationsOn = (machines: Machines["Service"]) =>
  SandboxCommand.operations((target: Target) =>
    Effect.succeed(machines.commands(target.branch, target.ownerId, target.callId))
  )

/** The job's steps over the host's `Machines` (`operationsOn`). */
export const registration = Layer.unwrap(
  Effect.map(Machines, (machines) => Command.toLayer(operationsOn(machines))),
).pipe(Layer.provideMerge(Action.layerImplementations))

/**
 * How long past a command's own timeout the step that asks for it waits on it (`Command.run`): the command's stop (TERM,
 * then KILL five seconds later) and the read that sees it end.
 */
export const STOP_MARGIN_MS = 15_000

/**
 * `SANDBOX_COMMAND_STEP_WAIT_SECONDS`: the longest the step that asks for a command waits on it in the step itself, in
 * whole seconds from 0 (never: every command goes on as its job, and its run parks) to `COMMAND_LIMIT_SECONDS`, which it
 * is unless set (as long as the command may run). Waiting holds the run's drive, and on Cloudflare its Durable Object's
 * alarm, while the command runs (`flows_external_job_step_wait` counts that time). Any other value fails with a
 * `ConfigError`. The `FlowExecution` object reads it once.
 */
export const stepWaitSeconds: Config.Config<number> = Config.schema(
  Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: COMMAND_LIMIT_SECONDS })),
  "SANDBOX_COMMAND_STEP_WAIT_SECONDS",
).pipe(Config.withDefault(COMMAND_LIMIT_SECONDS))

/**
 * How long the step that asks for `call` waits on it in the step itself: as long as the command may run and stop, at
 * most `capSeconds` (`SANDBOX_COMMAND_STEP_WAIT_SECONDS`). The drive's budget bounds it too
 * (`FlowRuntime.DriveDeadline`): a command still running then goes on as its job, and the run parks.
 */
export const stepWait = (call: typeof SandboxTools.Run.Type, capSeconds: number = COMMAND_LIMIT_SECONDS): Duration.Input =>
  Math.min((call.timeoutSeconds ?? SandboxTools.limits.defaultTimeoutSeconds) * 1000 + STOP_MARGIN_MS, capSeconds * 1000)

/** The execution id of call `callId`'s command: from the call's own id, so the call asked again joins the same job. */
export const commandExecutionId = (callId: string): string => `sandbox-command:${callId}`

/** The run a command was asked for outside of: a tool called with no flow runtime in scope. */
export class NoRun extends Schema.TaggedError<NoRun>()("@smthrs/mvp/sandbox/NoRun", {}) {}

/**
 * Runs `call` on `target`'s machine, through `machines`, as call `callId`'s `sandbox/Command` (`Command.run`): a command
 * that ends within `wait` (`stepWait(call)` unless given, and the drive's budget) is started, waited on and collected in the step that asks, and a longer one goes on as the
 * job, a child of the run that asks, which parks while it runs. Asked again (a resumed run replaying the call) it starts
 * the same key, or joins the same job, so the command runs once and its result is collected once. Needs the asking
 * run's `FlowRuntime`, else fails `NoRun`.
 */
export const run = (
  machines: Machines["Service"],
  target: Omit<Target, "callId">,
  callId: string,
  call: typeof SandboxTools.Run.Type,
  wait: Duration.Input = stepWait(call),
) =>
  Effect.gen(function* () {
    const runtime = yield* Effect.serviceOption(FlowRuntime.FlowRuntime)
    if (Option.isNone(runtime)) return yield* new NoRun()
    // The job's implementations are registered with the runtime too (`registration`), for the job a longer command goes
    // on as.
    const ran = Command.run({ target: { ...target, callId }, call }, {
      executionId: commandExecutionId(callId),
      operations: operationsOn(machines),
      wait,
    })
    return yield* ran.pipe(Effect.provideService(FlowRuntime.FlowRuntime, runtime.value), Effect.provide(WebCrypto.layer))
  })
