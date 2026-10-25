import { type SandboxCommand, SandboxTools } from "@smthrs/sandbox"
import { Context, Effect, Schema } from "effect"
import { CheckoutFailed, type SandboxBranch, SandboxStartTimedOut, SandboxUnavailable } from "./Sandboxes.ts"

// What a branch's machine does for the sandbox tools and its own lifecycle (decision 0005 §2-§3,
// docs/features/sandbox-tools.md): run one tool call as the person who asked, and go to sleep when nothing happens in
// it. The machine is only a tool provider: it knows nothing about agents (0005 Q2). On Cloudflare it is the branch's
// `SandboxObject` and its container (worker/BranchSandboxes.ts); a test provides its own.

/** How a tool call ended on the machine, as it crosses a Durable Object's RPC: plain data, no class. */
export const ToolOutcome = Schema.Union([
  Schema.Struct({ _tag: Schema.Literal("Done"), result: SandboxTools.Result, generation: Schema.Number }),
  Schema.Struct({ _tag: Schema.Literal("Refused"), reason: SandboxTools.ToolRefused.fields.reason }),
  Schema.Struct({ _tag: Schema.Literal("Lost") }),
  Schema.Struct({ _tag: Schema.Literal("CheckoutFailed") }),
  // `start_timeout` when the machine didn't finish starting within SANDBOX_START_TIMEOUT_SECONDS.
  Schema.Struct({ _tag: Schema.Literal("Unavailable"), reason: Schema.optional(Schema.Literal("start_timeout")) }),
  // The sandbox limits leave no machine free (worker/branch/Budget.ts).
  Schema.Struct({ _tag: Schema.Literal("Waiting") }),
])
export type ToolOutcome = typeof ToolOutcome.Type

/**
 * One operation on a command started detached in a branch's machine (`SandboxTools.start`, `observe`, `collect`,
 * `cancel`), by its key, as it crosses a Durable Object's RPC. A start names the tool call it is for (`callId`) when it
 * has one, so the machine can tell a command that call already ran as a tool call.
 */
export const CommandRequest = Schema.Union([
  Schema.Struct({
    op: Schema.Literal("start"),
    key: Schema.String,
    call: SandboxTools.Run,
    callId: Schema.optional(Schema.String),
  }),
  // An observe may wait up to `waitMs` for the command to end (`SandboxTools.observe`), answering as soon as it does.
  Schema.Struct({ op: Schema.Literal("observe"), key: Schema.String, waitMs: Schema.optional(Schema.Number) }),
  Schema.Struct({ op: Schema.Literal("collect"), key: Schema.String }),
  Schema.Struct({ op: Schema.Literal("cancel"), key: Schema.String }),
])
export type CommandRequest = typeof CommandRequest.Type

/**
 * How a command operation ended on the machine, as plain data: the command `Started` on a generation of the machine,
 * what it is doing (`Observed`), its result (`Collected`), `Cancelled`, or why it couldn't (as `ToolOutcome` says).
 */
export const CommandOutcome = Schema.Union([
  Schema.Struct({ _tag: Schema.Literal("Started"), started: SandboxTools.Started, generation: Schema.Number }),
  Schema.Struct({ _tag: Schema.Literal("Observed"), observed: SandboxTools.Observed }),
  Schema.Struct({ _tag: Schema.Literal("Collected"), result: SandboxTools.RunResult }),
  Schema.Struct({ _tag: Schema.Literal("Cancelled") }),
  Schema.Struct({ _tag: Schema.Literal("Refused"), reason: SandboxTools.ToolRefused.fields.reason }),
  Schema.Struct({ _tag: Schema.Literal("Lost") }),
  Schema.Struct({ _tag: Schema.Literal("CheckoutFailed") }),
  Schema.Struct({ _tag: Schema.Literal("Unavailable"), reason: Schema.optional(Schema.Literal("start_timeout")) }),
  Schema.Struct({ _tag: Schema.Literal("Waiting") }),
  // The box's own session or script failed: the provider's code, and a script step's exit code.
  Schema.Struct({
    _tag: Schema.Literal("ToolUnavailable"),
    code: SandboxTools.ToolUnavailable.fields.code,
    exitCode: Schema.optional(Schema.Number),
  }),
])
export type CommandOutcome = typeof CommandOutcome.Type

/** How reaching a branch's machine for a command can fail, beside the tools' own failures. */
export const MachineFailure = Schema.Union([SandboxUnavailable, SandboxStartTimedOut, CheckoutFailed])
export type MachineFailure = typeof MachineFailure.Type

/** What a machine answers to `sleepIfIdle`: it `slept`, it is `busy`, or that generation is `gone` already. */
export const SLEEP_OUTCOMES = ["slept", "busy", "gone"] as const
export type SleepOutcome = (typeof SLEEP_OUTCOMES)[number]

/** A tool call's success on the machine: the tool's result, and the machine generation it ran on. */
export interface Ran {
  readonly result: SandboxTools.Result
  readonly generation: number
}

/** The branches' machines as the sandbox flows reach them, by branch id. */
export class Machines extends Context.Service<
  Machines,
  {
    /**
     * Runs `call` in the branch's machine as person `ownerId`'s own user, waking the machine first. A command runs at
     * most once per `callId`. A call that changes the working copy saves it (`SandboxTools.checkpoint`), so a machine
     * that stops loses none of it.
     */
    readonly tool: (
      branch: SandboxBranch,
      ownerId: string,
      callId: string,
      call: SandboxTools.Call,
    ) => Effect.Effect<
      Ran,
      SandboxTools.ToolRefused | SandboxTools.ToolLost | SandboxUnavailable | SandboxStartTimedOut | CheckoutFailed
    >
    /**
     * The commands person `ownerId` starts detached in the branch's machine, as their own user
     * (`SandboxCommand.Commands`): what a `sandbox/Command` job runs a command with (worker/flows/SandboxCommand.ts).
     * Only `start` wakes the machine; the rest answer for the generation the command started on, so a command whose
     * machine stopped since observes `lost`. A command starts at most once per key, and never once tool call `callId`
     * ran it as a tool call.
     */
    readonly commands: (
      branch: SandboxBranch,
      ownerId: string,
      callId?: string,
    ) => SandboxCommand.Commands<MachineFailure>
    /**
     * Puts generation `generation` of the branch's machine to sleep when nothing happened in it for `idleMs`: no call,
     * no terminal input, and no process but the shells. It saves the working copy first, and stays awake when it can't.
     * Never wakes a machine.
     */
    readonly sleepIfIdle: (
      branchId: string,
      generation: number,
      idleMs: number,
    ) => Effect.Effect<SleepOutcome, SandboxUnavailable>
  }
>()("@smthrs/mvp/branch/Machines") {}


/** A tool call's outcome on the machine as the tool's success, or its typed failure (`Machines.tool`). */
export const ranOf = (
  outcome: ToolOutcome,
): Effect.Effect<
  Ran,
  SandboxTools.ToolRefused | SandboxTools.ToolLost | SandboxUnavailable | SandboxStartTimedOut | CheckoutFailed
> =>
  outcome._tag === "Done"
    ? Effect.succeed<Ran>({ result: outcome.result, generation: outcome.generation })
    : outcome._tag === "Refused"
    ? Effect.fail(new SandboxTools.ToolRefused({ reason: outcome.reason }))
    : outcome._tag === "Lost"
    ? Effect.fail(new SandboxTools.ToolLost())
    : outcome._tag === "CheckoutFailed"
    ? Effect.fail(new CheckoutFailed())
    : outcome._tag === "Waiting"
    ? Effect.fail(new SandboxUnavailable({ reason: "waiting" }))
    : Effect.fail(outcome.reason === "start_timeout" ? new SandboxStartTimedOut() : new SandboxUnavailable({ reason: "exec" }))

/**
 * A command operation's answer that isn't the one it asked for, as the typed failure `SandboxCommand.Commands`
 * answers: a refusal, a lost command, a refused checkout, a start that timed out, else a machine that couldn't answer.
 */
const commandFailure = (outcome: CommandOutcome) =>
  outcome._tag === "Refused"
    ? new SandboxTools.ToolRefused({ reason: outcome.reason })
    : outcome._tag === "Lost"
    ? new SandboxTools.ToolLost()
    : outcome._tag === "CheckoutFailed"
    ? new CheckoutFailed()
    : outcome._tag === "ToolUnavailable"
    ? new SandboxTools.ToolUnavailable({
      code: outcome.code,
      ...(outcome.exitCode === undefined ? {} : { exitCode: outcome.exitCode }),
    })
    : outcome._tag === "Unavailable" && outcome.reason === "start_timeout"
    ? new SandboxStartTimedOut()
    : new SandboxUnavailable({ reason: outcome._tag === "Waiting" ? "waiting" : "exec" })

/**
 * The commands (`SandboxCommand.Commands`) over `ask`, which runs one operation on a branch's machine and answers its
 * plain outcome (on Cloudflare, the branch's `SandboxObject`). `woken` hears the generation each start ran on, for that
 * generation's `sandbox/Keep`. `callId` is the tool call the commands are for, which each start names.
 */
export const commandsOver = <R>(
  ask: (request: CommandRequest) => Effect.Effect<CommandOutcome, never, R>,
  woken: (generation: number) => Effect.Effect<void, never, R>,
  callId?: string,
): SandboxCommand.Commands<MachineFailure, R> => {
  const answer = <A>(request: CommandRequest, pick: (outcome: CommandOutcome) => A | undefined) =>
    Effect.flatMap(ask(request), (outcome) => {
      const picked = pick(outcome)
      return picked === undefined ? Effect.fail(commandFailure(outcome)) : Effect.succeed(picked)
    })
  return {
    start: (call, key) =>
      answer({ op: "start", key, call, ...(callId === undefined ? {} : { callId }) }, (outcome) =>
        outcome._tag === "Started" ? outcome : undefined).pipe(
        Effect.tap((outcome) => woken(outcome.generation)),
        Effect.map((outcome) => outcome.started),
      ),
    observe: (key, options) =>
      answer(
        { op: "observe", key, ...(options?.waitMs === undefined ? {} : { waitMs: options.waitMs }) },
        (outcome) => (outcome._tag === "Observed" ? outcome.observed : undefined),
      ),
    collect: (key) => answer({ op: "collect", key }, (outcome) => (outcome._tag === "Collected" ? outcome.result : undefined)),
    cancel: (key) => Effect.asVoid(answer({ op: "cancel", key }, (outcome) => (outcome._tag === "Cancelled" ? outcome : undefined))),
  }
}
