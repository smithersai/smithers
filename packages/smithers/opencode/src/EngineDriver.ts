/**
 * The driver over the durable flow engine: one `Agent.run` per prompt, as
 * one execution of one registered flow, in a SQLite engine under the served
 * directory.
 *
 * Every prompt is `engine.execute` of the `opencode/turn` flow with the
 * assistant message id as the execution id. The body resolves the seat,
 * runs the cell loop over the standard flows, and hands every harness
 * event to the sink `Turns` opened for the session. A permission park is
 * the `authorize` hook refusing a call before its durable boundary opens:
 * the execution suspends, the person answers, and `engine.resume` re-drives
 * the same id, so the replayed frame re-emits its events and the projection
 * updates the same cards, and the ask the person is looking at is announced
 * once however many times the engine drives the park. An interrupt is
 * `engine.interrupt`, whose body exit closes the projection; a Stop that lands
 * while a frame is on its way to a park is still a stop, because the engine
 * cancels the run the cancellation reaches ahead of the park's commit, so the
 * park such a body reports is read as that interrupt. A steer is a durable
 * notification the loop drains at its next frame boundary. A restart re-drives
 * what was open.
 *
 * The composition follows `docs/jev-harness/composition-brief.md`: the
 * engine is built over the host's guarded platform, the registration
 * context carries the agent, the seats, the registry, and the evaluator,
 * and the body's failure is projected through `settlementFailure` before it
 * settles.
 *
 * The cell's doors to Jev are the standard `classify` flows, bound over the
 * evaluator the host installs: Jev through the Vercel gateway when
 * `AI_GATEWAY_API_KEY` is set, else one that refuses every call as
 * `unreachable`, which the cell reads as `{ ok: false }` and goes on.
 *
 * @since 1.0.0
 */
import * as NodeCrypto from "@effect/platform-node/NodeCrypto"
import * as Agent from "@smthrs/agent/Agent"
import { patterns, settlementFailure } from "@smthrs/agent/AgentSession"
import * as Budget from "@smthrs/agent/Budget"
import * as QuotaPolicy from "@smthrs/agent/QuotaPolicy"
import * as SeatResolver from "@smthrs/agent/SeatResolver"
import * as StandardFlows from "@smthrs/agent/StandardFlows"
import * as Capability from "@smthrs/capability/Capability"
import * as Permission from "@smthrs/capability/Permission"
import * as DurableEngineState from "@smthrs/engine-store/DurableEngineState"
import * as StepBoundary from "@smthrs/engine-store/StepBoundary"
import * as WorkspaceSandbox from "@smthrs/engine-store/WorkspaceSandbox"
import { Flow, FlowRuntime, RetryPolicy } from "@smthrs/flow"
import * as NodeRuntime from "@smthrs/flows/NodeRuntime"
import type * as AgentEvent from "@smthrs/harness/AgentEvent"
import * as Cell from "@smthrs/harness/Cell"
import type * as FlowBinding from "@smthrs/harness/FlowBinding"
import { HarnessError, HarnessErrorCode } from "@smthrs/harness/HarnessError"
import * as Notifications from "@smthrs/harness/Notifications"
import * as QuickJSSandbox from "@smthrs/harness/QuickJSSandbox"
import type * as Sandbox from "@smthrs/harness/Sandbox"
import * as Steering from "@smthrs/harness/Steering"
import * as Jj from "@smthrs/jj"
import type * as ChildProcessSpawner from "@smthrs/kernel/ChildProcessSpawner"
import * as Evaluator from "@smthrs/model/Evaluator"
import { NotificationQueue } from "@smthrs/notifications"
import { Node } from "@smthrs/plan"
import * as Registry from "@smthrs/registry/Registry"
import { Ownership, RunStore } from "@smthrs/run-store"
import {
  Cause,
  type Context,
  Deferred,
  type Duration,
  Effect,
  Exit,
  Fiber,
  Layer,
  Option,
  Schema,
  Scope,
  Stream
} from "effect"
import type * as Crypto from "effect/Crypto"
import type * as FileSystem from "effect/FileSystem"
import { constFalse } from "effect/Function"
import type * as Path from "effect/Path"
import { randomUUID } from "node:crypto"
import { hostname } from "node:os"
import { resolve } from "node:path"
import * as Driver from "./Driver.ts"
import * as Health from "./Health.ts"
import * as Projection from "./Projection.ts"
import * as Store from "./Store.ts"

/**
 * What the host equips a turn with: the platform a flow body reaches the
 * world through (the filesystem, paths, and the process spawner, guarded
 * the way the host guards them), the seat resolver, and the flow registry.
 *
 * The CLI builds these from `NodeControl`; a test builds them from the
 * Node platform and a scripted seat.
 *
 * @category models
 * @since 1.0.0
 */
export interface Host {
  readonly platform: Layer.Layer<FileSystem.FileSystem | Path.Path | ChildProcessSpawner.ChildProcessSpawner>
  readonly seats: Layer.Layer<SeatResolver.SeatResolver>
  readonly registry: Layer.Layer<Registry.Registry>
}

/**
 * The service slices the standard flows are built from, captured inside
 * the body where the engine's context is complete.
 *
 * @category models
 * @since 1.0.0
 */
export interface FlowServices {
  readonly filesystem: Context.Context<FileSystem.FileSystem | Path.Path>
  readonly shell: Context.Context<ChildProcessSpawner.ChildProcessSpawner | Path.Path>
  readonly engine: Context.Context<Crypto.Crypto | FlowRuntime.FlowRuntime | FlowRuntime.FlowInstance>
  readonly evaluator: Context.Context<Evaluator.Evaluator>
}

/**
 * How the driver is built.
 *
 * @category models
 * @since 1.0.0
 */
export interface Options {
  /** The served directory: the workspace root and the home of the database. */
  readonly directory: string
  /** The seat every turn runs on, as `provider:model`. */
  readonly seat: string
  readonly host: Host
  /** The frame budget per turn. One hundred by default (`Projection.defaultMaxFrames`); the CLI passes forty. */
  readonly maxFrames?: number | undefined
  /** The sandbox budget per cell. The CLI's values by default. */
  readonly limits?: Sandbox.Limits | undefined
  /** The flows a turn may call. The standard filesystem, shell, clock, and classify flows by default. */
  readonly flows?: ((services: FlowServices) => ReadonlyArray<FlowBinding.Source>) | undefined
  /** The evaluator classify calls go through. `Health.evaluatorLayer` over `environment` by default. */
  readonly evaluator?: Layer.Layer<Evaluator.Evaluator> | undefined
  /** Where `AI_GATEWAY_API_KEY` is read from when no evaluator is given. The process environment by default. */
  readonly environment?: Readonly<Record<string, string | undefined>> | undefined
  /** The flows a call to which asks the person first. `bash` by default. */
  readonly asks?: ReadonlyArray<string> | undefined
  /** The engine database. `<directory>/.smithers/opencode.sqlite` by default. */
  readonly databaseFile?: string | undefined
  /**
   * How long a body re-driven by the engine itself waits for the host to
   * open a sink for it before it runs with none. Thirty seconds by default.
   */
  readonly attachTimeout?: Duration.Input | undefined
}

/**
 * The sandbox budget the CLI runs every cell under.
 *
 * @category constants
 * @since 1.0.0
 */
export const defaultLimits: Sandbox.Limits = { memoryBytes: 256 * 1024 * 1024, steps: 50_000_000 }

/**
 * Consecutive read-only frames a turn may spend before the harness demands
 * an action: six here, half the harness default of twelve. The harness
 * default was read off task runs of a hundred frames; a turn in the app is
 * a person waiting, and the day-one drive on Cerebras spent 27 frames and
 * 290k input tokens answering "Say B" because the model printed the answer
 * instead of calling `ctx.done` and nothing bounded the streak. At six
 * read-only frames the harness issues its read-only demand (the next frame
 * must write or say why it cannot); at twelve it ends the run as
 * `read_only_cap`, which the projection closes as a red `stopped` health
 * decision. A frame with no call at all is read-only: the cap counts what
 * the frame left unchanged, not what it declared.
 *
 * @category constants
 * @since 1.0.0
 */
export const readOnlyCap = 6

/**
 * The host's teaching, passed as `Agent.Options.system`: what this host is
 * (a person's prompt in the app, not a task run) and when to answer. The
 * harness places it in the system context ahead of the task, after the
 * cell contract `CellTurn.teach` prepends; it is stable across frames, so
 * the model reads it on every one.
 *
 * @category constants
 * @since 1.0.0
 */
export const hostTeaching =
  "You are answering a person in a chat app. When the request is conversational, or your printed output already answers it, call ctx.done(answer) in that same cell. Ask clarifying questions with ctx.done(question), then wait for the person's next message. Call flows only when the request needs them. Never run a command the person did not ask for."

/**
 * The message a rejected call settles with. The harness appends its generic
 * `capability_refused` hint beside it ("This run cannot reach that flow"),
 * which the server cannot change, so the message says the hint is about
 * the flow and not this call, and that the flow stays open for commands
 * the person allows.
 *
 * @param flow the flow the person rejected a call to
 * @category constructors
 * @since 1.0.0
 */
export const deniedMessage = (flow: string): string =>
  `permission_denied: the person rejected this ${flow} call. Do not retry it; do the work another way or explain what you would have run. The generic hint beside this message is about the flow, not this call: the flow stays available for commands the person allows.`

/**
 * The message a call settles with when this turn already had the same
 * subject rejected: the person is not asked twice.
 *
 * A live drive parked `pytest -q`, was refused, and the very next frame
 * called `pytest -q` again, which parked a second identical card. The
 * refusal is the answer now, and it names what was rejected so the cell can
 * tell it from a fresh denial and stop.
 *
 * @param flow the flow the call asked for
 * @param subject what the rejected card showed, which this call repeats
 * @category constructors
 * @since 1.0.0
 */
export const repeatedDenialMessage = (flow: string, subject: string): string =>
  `permission_denied: the person already rejected \`${subject}\` in this turn, so this ${flow} call was refused without asking them again. Do not call it a third time: do the work another way, or say what you would have run.`

/**
 * The capability envelope every turn runs under: the standard flows over
 * the served directory and the shell.
 *
 * @category constants
 * @since 1.0.0
 */
export const envelope: ReadonlyArray<string> = ["fs:read:/**", "fs:write:/**", "proc:spawn:*", "model:call:*"]

/**
 * The database file under the served directory: `Store.databasePath`.
 *
 * @category getters
 * @since 1.0.0
 */
export const databasePath: (directory: string) => string = Store.databasePath

/**
 * The version control the engine is built over. Nothing in a turn calls it:
 * only compensable actions snapshot, and a turn has none.
 *
 * @category constants
 * @since 1.0.0
 */
export const inertJj = {
  snapshot: () => Effect.succeed({ changeId: "opencode" }),
  restore: () => Effect.void,
  diff: () => Effect.succeed("")
}

/**
 * The one durable flow every prompt executes. Its plan-time body is inert;
 * the behaviour is the `execute` the driver registers.
 *
 * @category constants
 * @since 1.0.0
 */
export const turnFlow = Flow.make("opencode/turn", {
  payload: { session: Schema.String, input: Schema.String },
  success: Schema.String,
  error: Schema.Unknown,
  body: () => Node.succeed("")
})

/**
 * How `execute` treats a parked execution: it does not re-drive it. The
 * engine's default keeps re-driving a suspended run on a backoff, which
 * replays a parked turn every few seconds until someone answers; here the
 * answer is what resumes it.
 *
 * @category constants
 * @since 1.0.0
 */
export const parkOnce: RetryPolicy.RetryPolicy = RetryPolicy.make({
  initialMs: 1,
  factor: 1,
  maxMs: 1,
  maxAttempts: 1
})

/**
 * The task the model is given: the prompt alone on a session's first turn,
 * the conversation tail ahead of it afterwards.
 *
 * @category conversions
 * @since 1.0.0
 */
export const task = (input: Driver.StartInput): string =>
  input.history === undefined || input.history === ""
    ? input.prompt
    : `The conversation so far, oldest first:\n\n${input.history}\n\nThe person now says:\n\n${input.prompt}`

/**
 * The id of the permission a call asks for, derived from the execution and
 * the call identity so the replay after an answer asks the same question.
 *
 * @category constructors
 * @since 1.0.0
 */
export const requestID = (
  executionId: string,
  identity: { readonly frame: number; readonly cell: string; readonly ordinal: number }
): string =>
  `per_${executionId.slice(executionId.indexOf("_") + 1)}_${identity.frame}_${
    identity.cell.slice(0, 8)
  }_${identity.ordinal}`

/**
 * The standard flows: filesystem, shell, clock, and classify with the three
 * curated classifiers `@smthrs/std` ships.
 *
 * @category constructors
 * @since 1.0.0
 */
export const standardFlows = (services: FlowServices): ReadonlyArray<FlowBinding.Source> => [
  StandardFlows.filesystem(services.filesystem),
  StandardFlows.shell(services.shell),
  StandardFlows.clock(services.engine),
  StandardFlows.classify(services.evaluator)
]

/**
 * Wraps the bindings of a source so a call the person rejected settles as
 * a failure the cell can read instead of failing the frame.
 *
 * @param source the source to wrap
 * @param refusal the message a refused call settles with, or `undefined` to run it
 * @category combinators
 * @since 1.0.0
 */
export const refusing = (
  source: FlowBinding.Source,
  refusal: (call: Cell.Call) => string | undefined
): FlowBinding.Source => ({
  name: source.name,
  bindings: () =>
    Effect.map(source.bindings(), (bindings) =>
      bindings.map((binding): FlowBinding.Binding => {
        const run: FlowBinding.Binding["run"] = (call) => {
          const message = refusal(call)
          return message === undefined ? binding.run(call) : Effect.succeed(
            new Cell.CallResult({
              outcome: "failure",
              value: { permission: "denied", flow: call.flowName },
              message,
              code: "capability_refused"
            })
          )
        }
        return { descriptor: binding.descriptor, run }
      }))
})

interface Running {
  readonly input: Driver.StartInput
  readonly sink: Driver.Sink
  /**
   * The permission the execution is parked on, when it is: the subject its
   * card showed, and the key Allow always grants, which is absent when the
   * card offered no pattern and an answer therefore covers this call alone.
   */
  parked: {
    readonly requestID: string
    readonly flow: string
    readonly subject: string
    readonly always: string | undefined
  } | undefined
  /** The body's exit for the drive in flight. */
  settled: Deferred.Deferred<Driver.Outcome>
  driving: boolean
  /**
   * Set when the person asked this turn to stop, and never cleared: a Stop is
   * about the turn, and the turn ends.
   *
   * A frame that parks a moment after the Stop reports the park its body saw,
   * and the engine has already cancelled the run underneath it: the
   * cancellation is recorded before the park's own commit, so the commit is
   * guarded away and nothing will resume the row. Reporting that park would
   * leave the session busy for good with no card to answer, which is why the
   * park of an aborting turn is read as the interrupt it belongs to.
   */
  aborting: boolean
  /**
   * The permission request ids this turn has announced. The engine drives a
   * suspended execution once more of its own accord, which replays the frame
   * and asks the same question again; the person is looking at one card, so
   * the ask is announced once per request id and not once per drive.
   */
  readonly announced: Set<string>
}

/**
 * Whether an ask is the turn's first under its request id, remembering it when
 * it is. A repeat is a replay of the ask the person already has in front of
 * them, not a second question.
 */
const announces = (running: Running, requestID: string): boolean => {
  if (running.announced.has(requestID)) return false
  running.announced.add(requestID)
  return true
}

const grantKey = (sessionID: string, key: string): string => `${sessionID}\u0000${key}`

/**
 * The subjects one turn had rejected, by execution: what makes a second ask
 * of a rejected call a refusal the cell reads rather than a second card. The
 * memory is the turn's, and {@link Options} keeps no state across turns: a
 * new turn asks the person again, because the answer was about this one.
 */
const denials = new Map<string, Set<string>>()

/** The rejected subjects of an execution, empty until one is rejected. */
const denialsOf = (executionId: string): Set<string> => {
  const known = denials.get(executionId)
  if (known !== undefined) return known
  const fresh = new Set<string>()
  denials.set(executionId, fresh)
  return fresh
}

/**
 * The key an Allow always on a call grants: the flow and the card's `always`
 * pattern, `bash echo *` for `echo one`, so a later `rm -rf` asks again.
 * What the app shows on the card is what the answer covers.
 *
 * `undefined` when the card offers no pattern, which is a bash call whose
 * subject is program text rather than a command line: nothing about it can
 * be generalised, so Allow always covers that one call and no other.
 *
 * @param directory the served directory, which the card's input is relative to
 * @param flow the flow the call asked for
 * @param input the call's input
 * @category constructors
 * @since 1.0.0
 */
export const alwaysKey = (directory: string, flow: string, input: Schema.Json): string | undefined => {
  const pattern = Projection.permissionPatterns(flow, Projection.toolInput(directory, flow, input)).always[0]
  return pattern === undefined ? undefined : `${flow} ${pattern}`
}

/**
 * What a call's card shows as its subject: the command line of a bash call,
 * the program of a script-form one, the file of an edit. Two calls with the
 * same subject ask the person the same question, which is what makes a
 * second ask of a rejected one a nag rather than a new decision.
 *
 * @param directory the served directory, which the card's input is relative to
 * @param flow the flow the call asked for
 * @param input the call's input
 * @category conversions
 * @since 1.0.0
 */
export const cardSubject = (directory: string, flow: string, input: Schema.Json): string =>
  Projection.permissionPatterns(flow, Projection.toolInput(directory, flow, input)).patterns[0]

/** The key a rejected subject is remembered under for the turn. */
const deniedKey = (flow: string, subject: string): string => `${flow} ${subject}`

/**
 * The message of a failure: an error's own, or the `message` of the JSON
 * projection the engine published for one.
 */
const failureMessage = (cause: Cause.Cause<unknown>): string => {
  const error = Cause.squash(cause)
  return error instanceof Error ? error.message : JSON.stringify(error)
}

/**
 * The harness code a failure carries, or `undefined` when nothing in it is a
 * `HarnessError`.
 *
 * Both shapes are read, because a failure reaches here two ways: live, as the
 * class the harness raised, and replayed, as the JSON projection the engine
 * journaled it to, which keeps the fields and loses the prototype. The set is
 * closed by `HarnessError.HarnessErrorCode`, and a code outside it is not one
 * of ours, so it is not reported as one.
 *
 * This is what 091697c6 left behind: `failedOutcome` kept the `ModelError` it
 * found and dropped the `HarnessError` around it, so every cap and every
 * refusal the harness itself makes reached `Projection.close` as an untyped
 * sentence and the dot went gray reading `failed`.
 *
 * @param error the squashed failure
 * @category conversions
 * @since 1.0.0
 */
export const harnessStop = (error: unknown): Driver.HarnessStop | undefined => {
  const code = (error as { readonly code?: unknown } | undefined)?.code
  return typeof code === "string" && HarnessErrorCode.literals.includes(code as never)
    ? { code: code as Driver.HarnessStop["code"] }
    : undefined
}

/**
 * The outcome a failed body settles as. A model call the provider refused
 * (a bad key, an account with no credit, a closed quota window) is found
 * through the frame's wrapper, live or as the engine's JSON projection, and
 * reported with the seat, the code, the HTTP status, and the provider's
 * message verbatim; any other failure keeps its own message.
 *
 * Every arm also carries the harness's own code when there is one
 * ({@link harnessStop}), because the two answer different questions: the
 * provider failure says what to fix at the provider, and the harness code
 * says that the harness ended the run and which rule of its own ended it. A
 * frame that fails on a refused model call carries both.
 *
 * @param seat the seat the turn ran on
 * @param cause the body's failure
 * @category conversions
 * @since 1.0.0
 */
export const failedOutcome = (seat: string, cause: Cause.Cause<unknown>): Driver.Outcome => {
  const squashed = Cause.squash(cause)
  const harness = harnessStop(squashed)
  const unjudged = judgeRefusal(squashed)
  if (unjudged !== undefined) {
    return { _tag: "failed", message: failureMessage(cause), provider: unjudged, harness }
  }
  const model = Option.getOrUndefined(QuotaPolicy.modelErrorOf(squashed))
  if (model === undefined) return { _tag: "failed", message: failureMessage(cause), harness }
  const provider: Driver.ProviderFailure = {
    seat,
    providerID: seat.slice(0, Math.max(seat.indexOf(":"), 0)) || seat,
    code: model.code,
    status: model.httpStatus,
    message: model.message
  }
  return {
    _tag: "failed",
    message: `${model.code}${
      model.httpStatus === undefined ? "" : ` (HTTP ${model.httpStatus})`
    } from ${seat}: ${model.message}`,
    provider,
    harness
  }
}

/**
 * The provider a refused judge is reported against: the Vercel AI Gateway,
 * which is the host `AI_GATEWAY_API_KEY` opens, not the seat's provider.
 *
 * @category constants
 * @since 1.0.0
 */
export const judgeProviderID = "vercel-gateway"

/**
 * The seat the completion brake runs on: Jev, on the Vercel AI Gateway. It is
 * not a seat the operator chose, so a refusal of it is reported against this
 * name and never against the turn's model seat.
 *
 * @category constants
 * @since 1.0.0
 */
export const judgeSeat = `${judgeProviderID}:${Evaluator.defaultModel}`

/**
 * The refusal a turn no evaluator could judge reports, or `undefined` when
 * the failure is not one.
 *
 * `completion_unjudged` is the harness failing a turn because the gateway
 * would not answer whether the run's own completion stands
 * (`CompletionClaim.read`). It reached the app as a bare `UnknownError`,
 * against the house rule that every failure is typed: a 401 on the judge is
 * as fixable as a 401 on the seat, and the person fixing it needs to be told
 * which key. So it gets the shape every other refusal has, a seat, a
 * normalized code, the HTTP status, and the words verbatim, which the
 * projection renders as `ProviderAuthError` for a key and as a red dot for a
 * usage limit.
 *
 * The code comes off the transport's own, carried on the `HarnessError`
 * cause as `Classifier.ClassifierError` (live) or as its JSON projection
 * (replayed): 401 and 403 are `authentication`, 429 is `rate_limited`, and
 * anything else keeps the transport's `EvaluatorErrorCode`. Never off the
 * sentence, which is the same rule `Health.limitReached` states.
 *
 * @param error the squashed failure
 * @category conversions
 * @since 1.0.0
 */
export const judgeRefusal = (error: unknown): Driver.ProviderFailure | undefined => {
  const harness = error as { readonly code?: unknown; readonly message?: unknown; readonly cause?: unknown }
  if (harness?.code !== "completion_unjudged") return undefined
  const transport = harness.cause as { readonly code?: unknown; readonly status?: unknown } | undefined
  const status = typeof transport?.status === "number" ? transport.status : undefined
  // No status is a gateway that answered nothing: an unreachable host, this
  // call's own deadline, or a host that installed no evaluator at all. There
  // is no provider to name in any of those, and the message already says
  // which, so the failure keeps its own words.
  if (status === undefined) return undefined
  const code = status === 401 || status === 403
    ? "authentication"
    : status === 429
    ? "rate_limited"
    : typeof transport?.code === "string"
    ? transport.code
    : "completion_unjudged"
  return {
    seat: judgeSeat,
    providerID: judgeProviderID,
    code,
    status,
    message: typeof harness.message === "string" ? harness.message : "A completion no evaluator could judge"
  }
}

/**
 * What a host is told when it can judge no completion, word for word.
 *
 * The harness asks Jev whether the sentence a turn wrote describes what the
 * turn did, and a claim nothing could judge ends the run as
 * `completion_unjudged` rather than standing (`CompletionClaim`,
 * `HarnessError`). That brake is deliberate and it has no fallback, so a
 * server started without an evaluator is a server that answers a
 * conversation and fails every real task at its first completion. The verb
 * refuses at startup instead, which is the same refusal an hour earlier.
 *
 * No colon follows the variable name. The journal redactor rewrites
 * `<name ending in KEY><colon><token>` to `[REDACTED]`, so a sentence that
 * punctuates the name that way reaches the operator with a word missing
 * (`packages/flows/journal/src/Redaction.ts`).
 *
 * @category constants
 * @since 1.0.0
 */
export const noEvaluator =
  "smithers opencode needs AI_GATEWAY_API_KEY, because the harness asks Jev to judge every completion and fails a run it cannot judge. Export AI_GATEWAY_API_KEY (Vercel AI Gateway) and start again, or pass --scripted to replay the recorded turn without a model."

/**
 * Why this host cannot run a turn, or `undefined` when it can:
 * {@link noEvaluator} when the options name no evaluator and the
 * environment holds no gateway key.
 *
 * The question is what the host can provide, not what one variable says. A
 * host that injects its own evaluator, which is what the tests and any
 * scripted judge do, starts whatever the environment holds; a host that
 * leaves the evaluator to {@link Options.environment} is refused when that
 * environment cannot build one. The rule mirrors {@link layer}'s default so
 * the preflight and the layer read the same two fields.
 *
 * @param options the driver options the host will build with
 * @category predicates
 * @since 1.0.0
 */
export const evaluatorRefusal = (
  options: Pick<Options, "evaluator" | "environment">
): string | undefined =>
  options.evaluator !== undefined ||
    Health.evaluatorConfigured(options.environment ?? Health.ambientEnvironment())
    ? undefined
    : noEvaluator

/**
 * The line the server logs when the seat refused a model call: the seat,
 * what the provider said, and how to run on another seat.
 *
 * @category conversions
 * @since 1.0.0
 */
export const seatFailureLine = (failure: Driver.ProviderFailure): string =>
  failure.providerID === judgeProviderID
    ? judgeFailureLine(failure)
    : `Seat ${failure.seat} refused the model call (${failure.code}${
      failure.status === undefined ? "" : `, HTTP ${failure.status}`
    }): ${failure.message} Pass --seat provider:model or set SMITHERS_SEAT to run on another seat.`

/**
 * The line the server logs when the gateway refused the completion brake.
 *
 * The way out is the gateway key, never another seat: the judge is not a seat
 * the operator picked, so the seat advice would send them to change the one
 * thing that is working. `AI_GATEWAY_API_KEY` is written without a colon
 * after it because the journal redactor rewrites `<name ending in
 * KEY><colon><token>` to `[REDACTED]`; see {@link noEvaluator}.
 *
 * @param failure the refusal {@link judgeRefusal} built
 * @category conversions
 * @since 1.0.0
 */
export const judgeFailureLine = (failure: Driver.ProviderFailure): string =>
  `The completion judge ${failure.seat} refused the call (${failure.code}${
    failure.status === undefined ? "" : `, HTTP ${failure.status}`
  }): ${failure.message} Check AI_GATEWAY_API_KEY and the gateway's status; the run's own seat is not the problem.`

/**
 * Builds the driver and the store over one engine database. The layer
 * exposes both, because the store shares the engine's connection and the
 * turns need the same store the driver records grants and open turns in.
 *
 * @category layers
 * @since 1.0.0
 */
export const layer = (options: Options) =>
  Layer.unwrap(Effect.sync(() => {
    const directory = resolve(options.directory)
    const databaseFile = options.databaseFile ?? databasePath(directory)
    const asks = new Set(options.asks ?? ["bash"])
    const maxFrames = options.maxFrames ?? Projection.defaultMaxFrames
    const limits = options.limits ?? defaultLimits
    const flowsOf = options.flows ?? standardFlows
    const evaluator = options.evaluator ??
      Health.evaluatorLayer(options.environment ?? Health.ambientEnvironment())
    const attachTimeout = options.attachTimeout ?? "30 seconds"
    const grants = { always: new Set<string>(), once: new Set<string>(), denied: new Set<string>() }
    const sessions = new Map<string, Running>()
    const executions = new Map<string, Running>()
    const waiters = new Map<string, Deferred.Deferred<Running>>()
    /** The fiber of every body this process is running, so a shutdown can interrupt them first. */
    const bodies = new Map<string, Fiber.Fiber<unknown, unknown>>()
    let stopping = false

    const remember = (grant: Store.Grant): void => {
      if (grant.kind === "always") grants.always.add(grantKey(grant.sessionID, grant.key))
      else if (grant.kind === "once") grants.once.add(grant.key)
      else grants.denied.add(grant.key)
    }

    /** Registers a running turn, and wakes a body that was waiting for it. */
    const register = (input: Driver.StartInput, sink: Driver.Sink): Effect.Effect<Running> =>
      Effect.gen(function*() {
        const running: Running = {
          input,
          sink,
          parked: undefined,
          settled: yield* Deferred.make<Driver.Outcome>(),
          driving: false,
          aborting: false,
          announced: new Set()
        }
        sessions.set(input.sessionID, running)
        executions.set(input.messageID, running)
        const waiter = waiters.get(input.messageID)
        if (waiter !== undefined) {
          waiters.delete(input.messageID)
          yield* Deferred.succeed(waiter, running)
        }
        return running
      })

    /**
     * The running turn of an execution the engine is driving: registered by
     * the driver, or awaited for a while when the engine re-drove a released
     * run on its own before the host opened a sink for it.
     */
    const attach = (executionId: string): Effect.Effect<Running | undefined> =>
      Effect.gen(function*() {
        const known = executions.get(executionId)
        if (known !== undefined) return known
        const waiter = waiters.get(executionId) ?? (yield* Deferred.make<Running>())
        waiters.set(executionId, waiter)
        const attached = yield* Effect.timeoutOption(Deferred.await(waiter), attachTimeout)
        if (Option.isNone(attached)) waiters.delete(executionId)
        return Option.getOrUndefined(attached)
      })

    const authorize = (instance: FlowRuntime.FlowInstance["Service"], sessionID: string) => (call: Cell.Call) =>
      Effect.gen(function*() {
        if (!asks.has(call.flowName)) return
        // What the card offered, and nothing wider. Every flow but bash offers
        // its whole self, so its own key is `<flow> *`; a `bash *` row can only
        // come from a database written before the bash card stopped offering
        // one, and it now matches no bash call at all.
        const always = alwaysKey(directory, call.flowName, call.input)
        if (always !== undefined && grants.always.has(grantKey(sessionID, always))) return
        const id = requestID(instance.executionId, call.identity)
        if (grants.once.has(id) || grants.denied.has(id)) return
        const subject = cardSubject(directory, call.flowName, call.input)
        // The same question, already answered no in this turn: the binding
        // settles it as that refusal instead of parking the card again.
        if (denialsOf(instance.executionId).has(deniedKey(call.flowName, subject))) return
        const running = executions.get(instance.executionId)
        if (running !== undefined) running.parked = { requestID: id, flow: call.flowName, subject, always }
        yield* Effect.provideService(
          FlowRuntime.annotateWaiting({ reason: "approval", token: id }),
          FlowRuntime.FlowInstance,
          instance
        )
        return yield* Effect.fail(
          new HarnessError({
            code: "engine_failed",
            message: `Permission required: ${call.flowName}`,
            cause: Schema.encodeUnknownSync(Permission.PermissionRequired)(
              new Permission.PermissionRequired({
                code: "permission_required",
                requestId: id,
                runId: instance.executionId,
                capability: Capability.make("proc:spawn", call.flowName),
                tier: "irreversible",
                meta: {
                  flow: call.flowName,
                  input: call.input,
                  identity: { frame: call.identity.frame, cell: call.identity.cell, ordinal: call.identity.ordinal }
                }
              })
            )
          })
        )
      })

    const registration = Layer.effectDiscard(
      Effect.gen(function*() {
        const engine = yield* FlowRuntime.FlowRuntime
        const agent = yield* Agent.Agent
        const seats = yield* SeatResolver.SeatResolver
        const registry = yield* Registry.Registry
        const queue = yield* NotificationQueue.NotificationQueue
        yield* engine.register(turnFlow, (payload) =>
          Effect.gen(function*() {
            const instance = yield* FlowRuntime.FlowInstance
            bodies.set(instance.executionId, yield* Effect.withFiberSucceed((fiber) => fiber))
            const input = JSON.parse(payload.input) as Driver.StartInput
            const running = yield* attach(instance.executionId)
            const seat = yield* seats.resolve(options.seat)
            const steering = yield* Notifications.make({
              runId: instance.executionId,
              lineageId: instance.executionId
            }).pipe(Effect.provideService(NotificationQueue.NotificationQueue, queue))
            const services: FlowServices = {
              filesystem: yield* Effect.context<FileSystem.FileSystem | Path.Path>(),
              shell: yield* Effect.context<ChildProcessSpawner.ChildProcessSpawner | Path.Path>(),
              engine: yield* Effect.context<Crypto.Crypto | FlowRuntime.FlowRuntime | FlowRuntime.FlowInstance>(),
              evaluator: yield* Effect.context<Evaluator.Evaluator>()
            }
            const refusal = (call: Cell.Call): string | undefined => {
              if (grants.denied.has(requestID(instance.executionId, call.identity))) return deniedMessage(call.flowName)
              const subject = cardSubject(directory, call.flowName, call.input)
              return denialsOf(instance.executionId).has(deniedKey(call.flowName, subject))
                ? repeatedDenialMessage(call.flowName, subject)
                : undefined
            }
            let output = ""
            yield* agent.run({
              contextWindowTokensFor: SeatResolver.contextWindowResolver(seats),
              session: payload.session,
              seat,
              prompt: task(input),
              registry,
              flows: flowsOf(services).map((source) => refusing(source, refusal)),
              authorize: authorize(instance, payload.session),
              capabilityEnvelope: patterns(envelope),
              limits,
              maxFrames,
              // This host has permission replies, but no question-card reply
              // route. Model-requested parks must not create an unanswerable
              // waiting turn; clarification is an ordinary chat answer.
              approvalChannel: false,
              system: [hostTeaching],
              // A turn that only reads, or only prints, is demanded at six
              // frames and stopped at twelve; see `readOnlyCap`.
              readOnlyCap,
              // A conversational answer changes no file; the unmoved-tree
              // demand would bounce every completion of such a prompt.
              unmovedCap: 0
            }).pipe(
              Stream.runForEach((event: AgentEvent.AgentEvent) =>
                Effect.suspend(() => {
                  if (event._tag === "transition-applied" && event.transition._tag === "complete") {
                    output = event.transition.output
                  }
                  if (running === undefined) return Effect.void
                  // One card per question. A replayed drive asks again under
                  // the same request id, and the second ask would stand a
                  // duplicate card beside the one being answered.
                  return event._tag === "permission-required" && !announces(running, event.request.requestId)
                    ? Effect.void
                    : running.sink.event(event)
                })
              ),
              Effect.provide(Layer.mergeAll(QuotaPolicy.layerDefault(), Budget.layer({}), QuickJSSandbox.layer)),
              Effect.provideService(Steering.Source, steering)
            )
            return output
          }).pipe(
            Effect.onExit((exit) =>
              Effect.flatMap(FlowRuntime.FlowInstance, (instance) => {
                bodies.delete(instance.executionId)
                const running = executions.get(instance.executionId)
                if (running === undefined) return Effect.void
                // A park, a cancel, and a shutdown all arrive as an
                // interrupt-only cause; `instance.suspended` tells the park
                // apart, and the driver knows when it is stopping.
                const outcome: Driver.Outcome = Exit.isSuccess(exit)
                  ? { _tag: "completed" }
                  : Cause.hasInterruptsOnly(exit.cause)
                  ? (instance.suspended || stopping ? { _tag: "suspended" } : { _tag: "interrupted" })
                  : failedOutcome(options.seat, exit.cause)
                return Effect.asVoid(Deferred.succeed(running.settled, outcome))
              })
            ),
            // The flow's error schema is `Schema.Unknown`; a live error does
            // not encode, so the failure settles as its JSON projection.
            Effect.mapError(settlementFailure)
          ))
      })
    ).pipe(
      Layer.provide([
        Agent.layer.pipe(Layer.provide(Layer.mergeAll(QuotaPolicy.layerDefault(), Budget.layer({})))),
        options.host.seats,
        options.host.registry,
        evaluator
      ]),
      // The queue the body drains steers from is built inside the engine and
      // carried out with the registration, so the driver admits steers into
      // the same queue instead of building a second engine to reach one.
      Layer.provideMerge(NotificationQueue.layer)
    )

    const engine = NodeRuntime.layer(
      {
        filename: databaseFile,
        workspaceRoot: directory,
        owner: { hostId: hostname() },
        isAlive: Ownership.sameHostPidProbe
      },
      StepBoundary.layer,
      WorkspaceSandbox.layerFileSystem(),
      registration
    ).pipe(Layer.provide([options.host.platform, NodeCrypto.layer, Jj.layerNoop(inertJj)]))

    const store = Store.layer

    const driver = Layer.effect(
      Driver.Driver,
      Effect.gen(function*() {
        const runtime = yield* FlowRuntime.FlowRuntime
        const state = yield* DurableEngineState.DurableEngineState
        const rows = yield* RunStore.RunStore
        const queue = yield* NotificationQueue.NotificationQueue
        const stored = yield* Store.Store
        // The drives are forked into the driver's own scope, so shutting the
        // server down interrupts them and the engine releases their rows for
        // the next process to reclaim.
        const scope = yield* Scope.Scope
        for (const grant of yield* stored.listGrants()) remember(grant)
        // Shutdown interrupts every body this process is running while the
        // engine is still up, so the engine settles each round as a release
        // the next process reclaims, instead of leaving a row owned by a
        // process that is gone.
        yield* Effect.addFinalizer(() =>
          Effect.suspend(() => {
            stopping = true
            return Fiber.interruptAll(Array.from(bodies.values()))
          })
        )

        /**
         * The engine's view of an execution: its result once it has one,
         * `undefined` while it has none, and `missing` when it has no row.
         */
        const polled = (executionId: string): Effect.Effect<Flow.Result<unknown, unknown> | "missing" | undefined> =>
          runtime.poll(turnFlow, executionId).pipe(
            Effect.map((known) => Option.getOrUndefined(known)),
            Effect.catchTag("@smthrs/flow/FlowExecutionNotFound", () => Effect.succeed("missing" as const))
          )

        /** Whether the engine closed an execution as cancelled: a cancel is recorded, never settled as a result. */
        const cancelled = (executionId: string): Effect.Effect<boolean> =>
          rows.get(executionId).pipe(
            Effect.map((row) => row.status === "cancelled"),
            Effect.orElseSucceed(constFalse)
          )

        /**
         * Waits, for a while, until the engine has published what the body's
         * exit already said: the driver's caller must find the row parked or
         * settled, not still being written. An interrupted turn is not
         * waited for: a cancelled run carries no result to wait on (the
         * cancel is recorded, not settled), nothing re-drives it, and the
         * app is owed idle as soon as the body is gone.
         */
        const awaitPublished = (running: Running, outcome: Driver.Outcome): Effect.Effect<void> =>
          Effect.gen(function*() {
            if (outcome._tag === "interrupted") return
            const executionId = running.input.messageID
            for (let attempt = 0; attempt < 400 && !stopping && !running.aborting; attempt++) {
              const result = yield* polled(executionId)
              if (
                result !== undefined && result !== "missing" &&
                result._tag === (outcome._tag === "suspended" ? "Suspended" : "Complete")
              ) {
                return
              }
              yield* Effect.sleep("25 millis")
            }
          })

        const settle = (running: Running, outcome: Driver.Outcome): Effect.Effect<void> =>
          Effect.gen(function*() {
            yield* awaitPublished(running, outcome)
            // The park of a turn the person stopped is that stop: the engine
            // cancelled the run the moment the cancellation was recorded
            // ahead of the park's commit, and a park the commit won is swept
            // for the same request, so the turn is over either way and the
            // session is owed idle now rather than at a second Stop.
            const ended: Driver.Outcome = running.aborting && outcome._tag === "suspended"
              ? { _tag: "interrupted" }
              : outcome
            if (ended._tag === "failed" && ended.provider !== undefined) {
              yield* Effect.logError(seatFailureLine(ended.provider))
            }
            running.driving = false
            yield* running.sink.closed(ended)
            if (ended._tag === "suspended") return
            running.parked = undefined
            sessions.delete(running.input.sessionID)
            executions.delete(running.input.messageID)
            denials.delete(running.input.messageID)
            yield* Effect.ignoreCause(stored.settleTurn(running.input.messageID))
          })

        /**
         * The engine's last word on an execution, once it has one: a result,
         * a cancel, or, once the engine call returned, no row at all (a resume
         * of a row that is gone drives nothing and would otherwise never
         * settle the turn).
         */
        const published = (executionId: string, returned: () => boolean): Effect.Effect<Driver.Outcome> =>
          Effect.gen(function*() {
            for (;;) {
              const result = yield* polled(executionId)
              if (result === "missing" && returned()) {
                return { _tag: "failed", message: "The engine has no record of this turn" }
              }
              if (result !== undefined && result !== "missing" && result._tag === "Complete") {
                const exit = result.exit
                return Exit.isSuccess(exit) ? { _tag: "completed" } : failedOutcome(options.seat, exit.cause)
              }
              if (yield* cancelled(executionId)) return { _tag: "interrupted" }
              yield* Effect.sleep("50 millis")
            }
          })

        /**
         * One drive of an execution: the first one executes, a later one
         * resumes. Returns when the body exits or the engine publishes a
         * result it already had, and reports that to the sink.
         */
        const drive = (running: Running, mode: "execute" | "resume"): Effect.Effect<void> =>
          Effect.gen(function*() {
            const executionId = running.input.messageID
            running.settled = yield* Deferred.make<Driver.Outcome>()
            running.driving = true
            const settled = running.settled
            const run: Effect.Effect<unknown, unknown> = mode === "execute"
              ? runtime.execute(turnFlow, {
                executionId,
                payload: { session: running.input.sessionID, input: JSON.stringify(running.input) },
                discard: true,
                suspendedRetryPolicy: parkOnce
              })
              : runtime.resume(turnFlow, executionId)
            // The call's own outcome says nothing the body's exit and the
            // engine's published result do not: a completed id answers from
            // its row, a running body reports through `settled`, and a call
            // that drove nothing (a row that is gone or already cancelled)
            // is read off the row once the call returned.
            let returned = false
            yield* Effect.forkIn(
              Effect.ensuring(
                Effect.ignoreCause(run),
                Effect.sync(() => {
                  returned = true
                })
              ),
              scope
            )
            const outcome = yield* Effect.raceFirst(Deferred.await(settled), published(executionId, () => returned))
            yield* settle(running, outcome)
          })

        const start: Driver.Service["start"] = (input, sink) =>
          Effect.gen(function*() {
            if (sessions.has(input.sessionID)) {
              return yield* new Driver.DriverError({ code: "busy", message: `Session ${input.sessionID} is busy` })
            }
            yield* Effect.orDie(stored.putTurn(input))
            const running = yield* register(input, sink)
            yield* drive(running, "execute")
          })

        const interrupt: Driver.Service["interrupt"] = (sessionID) =>
          Effect.gen(function*() {
            const running = sessions.get(sessionID)
            if (running === undefined) return false
            // Recorded before the engine is told, so a park this Stop raced is
            // read as the stop it is whichever of the two lands first.
            running.aborting = true
            // A parked execution has no body to exit: the cancel is recorded
            // and the engine closes the run without re-executing it. Whether
            // there is a body is read before the engine is told, because
            // telling it ends the body: a driving turn that settles while this
            // call waits is settled by its own exit, and reading the flag
            // afterwards closed such a turn a second time.
            const parked = !running.driving
            yield* Effect.ignoreCause(runtime.interrupt(turnFlow, running.input.messageID))
            if (parked) {
              running.parked = undefined
              yield* settle(running, { _tag: "interrupted" })
            }
            return true
          })

        const permission: Driver.Service["permission"] = (input) =>
          Effect.gen(function*() {
            const running = sessions.get(input.sessionID)
            if (running === undefined) {
              return yield* new Driver.DriverError({
                code: "unknown_session",
                message: `Session ${input.sessionID} has no running turn`
              })
            }
            if (running.parked === undefined || running.parked.requestID !== input.permissionID) {
              return yield* new Driver.DriverError({
                code: "unknown_permission",
                message: `Permission ${input.permissionID} is not pending`
              })
            }
            const pattern = running.parked.always
            // Allow always on a card that offered no pattern buys the one
            // call it answered: there is nothing to generalise it to.
            const grant: Store.Grant = input.response === "always" && pattern !== undefined
              ? { sessionID: input.sessionID, kind: "always", key: pattern }
              : {
                sessionID: input.sessionID,
                kind: input.response === "reject" ? "reject" : "once",
                key: input.permissionID
              }
            if (input.response === "reject") {
              denialsOf(running.input.messageID).add(deniedKey(running.parked.flow, running.parked.subject))
            }
            remember(grant)
            yield* Effect.ignoreCause(stored.putGrant(grant))
            running.parked = undefined
            yield* drive(running, "resume")
          })

        const steer: Driver.Service["steer"] = (sessionID, text) =>
          Effect.gen(function*() {
            const running = sessions.get(sessionID)
            if (running === undefined) return false
            const executionId = running.input.messageID
            return yield* queue.admit(executionId, {
              _tag: "human-steer",
              id: `steer_${randomUUID()}`,
              targetLineageId: executionId,
              provenance: {
                sourceRunId: executionId,
                sourceLineageId: executionId,
                sourceTurn: 0,
                sourceActor: "person"
              },
              payload: { kind: "Message", body: text },
              delivery: "steer"
            }).pipe(
              Effect.map((receipt) => receipt.decision === "admitted"),
              Effect.orElseSucceed(constFalse)
            )
          })

        const resumeOnBoot: Driver.Service["resumeOnBoot"] = (open) =>
          Effect.gen(function*() {
            const turns = yield* Effect.orDie(stored.listTurns())
            for (const turn of turns) {
              const known = yield* runtime.poll(turnFlow, turn.messageID).pipe(
                Effect.catchTag("@smthrs/flow/FlowExecutionNotFound", () => Effect.succeed(undefined))
              )
              const result = known === undefined ? undefined : Option.getOrUndefined(known)
              const complete = result?._tag === "Complete" ? result : undefined
              if (known === undefined || complete !== undefined) {
                // Settled while the process was down, or never recorded by the
                // engine: nothing to re-drive, and the projection is told so.
                const sink = yield* Effect.orDie(open(turn))
                yield* Effect.ignoreCause(stored.settleTurn(turn.messageID))
                yield* sink.closed(
                  complete === undefined
                    ? { _tag: "failed", message: "The turn was lost when the server stopped" }
                    : Exit.isSuccess(complete.exit)
                    ? { _tag: "completed" }
                    : { _tag: "failed", message: "The turn failed while the server was down" }
                )
                continue
              }
              const sink = yield* Effect.orDie(open(turn))
              const running = yield* register(turn, sink)
              const waiting = yield* state.waiting(turn.messageID)
              if (Option.isSome(waiting) && waiting.value.reason === "approval" && waiting.value.token !== null) {
                // Parked on a permission: the pending request is in the store,
                // and the person's answer re-drives it.
                const token = waiting.value.token
                const pending = yield* Effect.orDie(stored.listPermissions(turn.sessionID))
                const request = pending.find((candidate) => candidate.id === token)
                const flow = request?.permission ?? "bash"
                const pattern = request?.always[0]
                // No stored card means no pattern to generalise: an answer to
                // this park covers the call it parked, and nothing else.
                running.parked = {
                  requestID: token,
                  flow,
                  subject: request?.patterns[0] ?? "*",
                  always: pattern === undefined ? undefined : `${flow} ${pattern}`
                }
                continue
              }
              yield* Effect.forkIn(drive(running, "resume"), scope)
            }
          })

        return { start, interrupt, permission, steer, resumeOnBoot }
      })
    )

    // One engine over the file. `NodeRuntime.layer` is fresh on every use,
    // so naming `engine` twice would open two connections with a zero busy
    // timeout and run two coordinators over one set of rows.
    return driver.pipe(Layer.provideMerge(store), Layer.provide(engine))
  }))
