import { Uuid } from "@smthrs/crypto"
import { FlowRuntime, Interpreter } from "@smthrs/flow"
import type { SandboxTools } from "@smthrs/sandbox"
import { type Crypto, Effect, Layer, Metric } from "effect"
import { requesterOf } from "../../flows/requests"
import { type CallRefused, SandboxClient, type Target } from "./api"
import { CALL_ID_NAMESPACE } from "./contract"
import {
  Diff,
  type Failure,
  List,
  Read,
  Run,
  SandboxCallFailed,
  SandboxCallRefused,
  SandboxCallRunning,
  SandboxCallUnavailable,
  SandboxCommandTooLong,
  Status,
  type tools,
  Write,
} from "./flows"
import { calls } from "./metrics"

// The sandbox tools' steps (docs/features/sandbox-tools.md#the-flows): `start` asks ChatApi to run the call, `result`
// reads how it stands until the machine settles it, both through `SandboxClient`, on this device's engine. The call's
// id is the version 5 UUID of the run's execution id, so a step run again, after a crash or with the tab closed and
// reopened, names the same call: ChatApi answers it as it stands, and the machine never runs it twice. Each settled
// call is counted and logged by tool and outcome; nothing records a command, a path or content.

const isUuid = (value: string) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)

/**
 * Whom the running call is for (decision 0013 §1): the agent's call is a child of its answer's run, so it works in that
 * answer's conversation, which ChatApi looks up, however the person's tab moved since; a person's call works in the
 * conversation pinned when they ran it. The execution id says which, so a resumed run decides the same.
 */
const targetOf = (conversationId: string | undefined) =>
  Effect.map(FlowRuntime.FlowInstance, ({ executionId }): { readonly target?: Target; readonly door: string } => {
    const requester = requesterOf(executionId)
    if (requester !== executionId && isUuid(requester)) return { target: { answerId: requester.toLowerCase() }, door: "agent" }
    return conversationId === undefined
      ? { door: "person" }
      : { target: { conversationId: conversationId.toLowerCase() }, door: "person" }
  })

/** What ChatApi's refusal means to the flow. */
export const refusalOf = (refused: CallRefused): SandboxCallRefused | SandboxCommandTooLong | SandboxCallUnavailable =>
  refused.status === 400 && refused.code === "too_long" && refused.maxSeconds !== undefined
    ? new SandboxCommandTooLong({ maxSeconds: refused.maxSeconds })
    : refused.status === 401
    ? new SandboxCallRefused({ reason: "sign_in" })
    : refused.status === 403
    ? new SandboxCallRefused({ reason: refused.code === "members_only" ? "members_only" : "forbidden" })
    : refused.status === 409 && refused.code === "locked"
    ? new SandboxCallRefused({ reason: "locked" })
    : refused.status === 404
    ? new SandboxCallRefused({ reason: "not_found" })
    : refused.status === 400 || refused.status === 413 || refused.status === 409
    ? new SandboxCallRefused({ reason: "invalid" })
    : new SandboxCallUnavailable()

/** Counts and logs how a call ended, by tool and outcome. */
const settled = (tool: SandboxTools.Tool, callId: string, outcome: string) =>
  Effect.andThen(
    Metric.update(Metric.withAttributes(calls, { tool, outcome }), 1),
    Effect.logWithLevel(outcome === "done" ? "Info" : "Warn")("sandbox.call").pipe(
      Effect.annotateLogs({ tool, outcome, callId, feature: "sandbox" }),
    ),
  )

const outcomeOf = (failure: Failure): string =>
  failure._tag === "@smthrs/mvp/sandbox/SandboxCommandTooLong"
    ? "too_long"
    : failure._tag === "@smthrs/mvp/sandbox/SandboxCallRefused"
    ? failure.reason
    : failure._tag === "@smthrs/mvp/sandbox/SandboxCallFailed"
    ? failure.failure
    : "unavailable"

/**
 * `sandbox/<tool>/start`: one `POST /api/sandbox/calls` for this run's call. A call the machine already settled failed
 * fails here; any other answer names the call for the result step.
 */
export const start = (tool: SandboxTools.Tool) =>
(input: { readonly conversationId?: string | undefined } & Record<string, unknown>) =>
  Effect.gen(function* () {
    const { executionId } = yield* FlowRuntime.FlowInstance
    const callId = yield* Uuid.v5(CALL_ID_NAMESPACE, executionId).pipe(Effect.orDie)
    const { door, target } = yield* targetOf(input.conversationId)
    yield* Effect.annotateCurrentSpan({ "smithers.sandbox.tool": tool, door })
    const fail = (failure: Failure) =>
      Effect.andThen(settled(tool, callId, outcomeOf(failure)), Effect.fail(failure))
    if (target === undefined) return yield* fail(new SandboxCallRefused({ reason: "invalid" }))
    const { conversationId: _pinned, ...fields } = input
    const call = { ...fields, tool } as SandboxTools.Call
    const answer = yield* Effect.result((yield* SandboxClient).start({ callId, call, ...target }))
    if (answer._tag === "Failure") return yield* fail(refusalOf(answer.failure))
    if (answer.success.status === "failed") return yield* fail(new SandboxCallFailed({ failure: answer.success.failure }))
    return { callId }
  }).pipe(Effect.withSpan("sandbox.call.start"))

/**
 * `sandbox/<tool>/result`: one `GET /api/sandbox/calls/<id>`. While the machine runs the call it fails
 * `SandboxCallRunning`, which the step's retry policy asks again; done, it answers the tool's result.
 */
export const result = (tool: SandboxTools.Tool) => ({ callId }: { readonly callId: string }) =>
  Effect.gen(function* () {
    const answer = yield* Effect.result((yield* SandboxClient).result(callId))
    const fail = (failure: Failure) =>
      Effect.andThen(settled(tool, callId, outcomeOf(failure)), Effect.fail(failure))
    if (answer._tag === "Failure") {
      const refusal = refusalOf(answer.failure)
      // Unreachable is not settled: the retry policy asks again.
      return yield* refusal._tag === "@smthrs/mvp/sandbox/SandboxCallUnavailable" ? Effect.fail(refusal) : fail(refusal)
    }
    const standing = answer.success
    if (standing.status === "running") return yield* new SandboxCallRunning()
    if (standing.status === "failed") return yield* fail(new SandboxCallFailed({ failure: standing.failure }))
    yield* settled(tool, callId, "done")
    return standing.result
  }).pipe(Effect.withSpan("sandbox.call.result", { attributes: { "smithers.sandbox.tool": tool } }))

type StartStep = (
  payload: typeof Run.Start.payloadSchema.Type,
) => Effect.Effect<{ readonly callId: string }, Failure, FlowRuntime.FlowInstance | Crypto.Crypto | SandboxClient>
type ResultStep = (
  payload: typeof Run.Result.payloadSchema.Type,
) => Effect.Effect<typeof Run.Result.successSchema.Type, Failure, SandboxClient>

/**
 * Registers one tool's flow with its steps. Every tool's flow has the same two steps over its own schemas, so the
 * types are `run`'s for all; the schemas each declares are its own.
 */
const register = (entry: (typeof tools)[number]) =>
  Interpreter.layerWithImplementations(
    entry.flow as typeof Run.flow,
    Layer.merge(
      (entry.Start as typeof Run.Start).toLayer(start(entry.tool) as StartStep),
      (entry.Result as typeof Run.Result).toLayer(result(entry.tool) as ResultStep),
    ),
  )

/** Registers every tool's flow with its steps, asking through the host's `SandboxClient`. */
export const registration = Layer.mergeAll(
  register(Run),
  register(Read),
  register(Write),
  register(List),
  register(Status),
  register(Diff),
)

/** The tools' flows, asking ChatApi on `origin`. Needs the host's `HttpClient` and `Crypto`. */
export const registrationAt = (origin: string) => registration.pipe(Layer.provide(SandboxClient.layer({ origin })))
