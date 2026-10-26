import { digestSync, Uuid } from "@smthrs/crypto"
import { FlowRuntime, Interpreter } from "@smthrs/flow"
import { RealmFlow } from "@smthrs/harness"
import { Effect, Layer, Metric, Schema } from "effect"
import { HttpClient } from "effect/http"
import { parts } from "../repo/flows"
import { BranchClient, type BranchWrite, BranchWrites, type TrackRefused } from "./api"
import { CONVERSATION_NAMESPACE } from "./contract"
import { OPERATION_ACTIONS } from "./creation"
import { selection } from "./creationSteps"
import { BranchTrackRefused, BranchTrackUnavailable } from "./flows"
import {
  BranchPublish,
  BranchResync,
  BranchUpdate,
  CallOperation,
  EvaluateOperation,
  OperationProgram,
  type OperationRequest,
  OperationStart,
  PublishRequest,
  ResyncRequest,
  SelectOperation,
  Submitted,
  Title,
  Body,
  UpdateRequest,
} from "./publishFlows"
import { requestTrack } from "./steps"

// Publish's and Update branch's steps on this device's engine (docs/features/branch-publish.md): the branch found as
// `branch/track` finds it, the repository's flow for the operation selected and run in the realm (branch creation's
// recipe, src/features/branch/creationSteps.ts), and its one host action sent as a write to ChatApi's writes route under
// an id the run derives, so every retry sends the same write. Records carry outcomes, never a title, a body or a name.

const invalid = () => new BranchTrackRefused({ reason: "invalid" })

/** Realm rounds and host calls of Publish and Update branch, by `operation` and `outcome`. */
export const steps = Metric.counter("smithers_branch_operation_steps", { incremental: true })

/** What ChatApi's refusal of a write means to the flow: a Publish already on its way or done is `exists`. */
export const writeFailure = (refused: TrackRefused) =>
  refused.status === 401
    ? new BranchTrackRefused({ reason: "sign_in" })
    : refused.status === 403
    ? new BranchTrackRefused({ reason: "forbidden" })
    : refused.status === 404
    ? new BranchTrackRefused({ reason: "not_found" })
    : refused.status === 400 || refused.status === 413
    ? new BranchTrackRefused({ reason: "invalid" })
    : refused.status === 409
    ? new BranchTrackRefused({ reason: "exists" })
    : refused.code === "not_configured"
    ? new BranchTrackRefused({ reason: "not_configured" })
    : new BranchTrackUnavailable()

/** The selection for the request's operation; one the route answered for another operation is refused. */
export const select = (origin: string) => (request: OperationRequest) =>
  selection(origin, { owner: request.owner, name: request.name, operation: request.operation }).pipe(
    Effect.filterOrFail((selection) => selection.operation === request.operation, invalid),
  )

const PublishCall = Schema.Struct({ title: Title, body: Body })
const UpdateCall = Schema.Struct({ method: Schema.Literals(["merge", "rebase"]) })

/** No output is accepted as an admitted write without a matching host receipt. */
export const evaluate = (state: typeof EvaluateOperation.payloadSchema.Type) =>
  Effect.gen(function* () {
    const { selection, request } = state
    if (selection.runtime !== RealmFlow.version || digestSync(selection.source) !== selection.digest || state.receipts.length > 1) {
      return yield* invalid()
    }
    const result = yield* RealmFlow.step({
      source: selection.source,
      expectedTag: selection.tag,
      payload: request.operation === "publish" ? { title: request.title ?? "", body: request.body ?? "" } : {},
      allowedActions: selection.allowed,
      receipts: state.receipts,
    }).pipe(Effect.mapError(invalid))
    yield* Metric.update(Metric.withAttributes(steps, { operation: request.operation, outcome: result._tag }), 1)
    yield* Effect.logInfo("branch.operation.evaluate").pipe(Effect.annotateLogs({ operation: request.operation, outcome: result._tag }))
    if (result._tag === "Action") {
      if (state.receipts.length !== 0) return yield* invalid()
      return result
    }
    const receipt = state.receipts[0]
    if (receipt?.outcome._tag !== "Success") return yield* invalid()
    const recorded = yield* Schema.decodeUnknownEffect(Submitted)(receipt.outcome.value).pipe(Effect.mapError(invalid))
    if (recorded.writeId !== request.request || recorded.branchId !== request.branchId) return yield* invalid()
    const value = yield* Schema.decodeUnknownEffect(Submitted)(result.value).pipe(Effect.mapError(invalid))
    if (value.writeId !== recorded.writeId || value.branchId !== recorded.branchId) return yield* invalid()
    return { _tag: "Complete" as const, value }
  }).pipe(Effect.withSpan("branch.operation.evaluate"))

/** The flow supplies the title and body, or the method; the host fixes the branch, the write's id and the session. */
export const call = ({ state, call }: typeof CallOperation.payloadSchema.Type) =>
  Effect.gen(function* () {
    const { request, selection } = state
    if (!selection.allowed.includes(call.name) || !OPERATION_ACTIONS[request.operation].includes(call.name as never)) {
      return yield* invalid()
    }
    const write: BranchWrite = request.operation === "publish"
      ? yield* Schema.decodeUnknownEffect(PublishCall)(call.payload).pipe(
        Effect.mapError(invalid),
        Effect.map((asked) => ({ writeId: request.request, op: "branch/publish" as const, branchId: request.branchId, title: asked.title, body: asked.body })),
      )
      : yield* Schema.decodeUnknownEffect(UpdateCall)(call.payload).pipe(
        Effect.mapError(invalid),
        Effect.map((asked) => ({ writeId: request.request, op: "branch/update" as const, branchId: request.branchId, method: asked.method })),
      )
    const sent = yield* Effect.result((yield* BranchWrites).send(request.owner, request.name, write))
    const outcome = sent._tag === "Success" ? "sent" : (() => {
      const failure = writeFailure(sent.failure)
      return failure._tag === "@smthrs/mvp/branch/BranchTrackRefused" ? failure.reason : "unavailable"
    })()
    yield* Metric.update(Metric.withAttributes(steps, { operation: request.operation, outcome }), 1)
    yield* Effect.logWithLevel(sent._tag === "Success" ? "Info" : "Warn")("branch.operation.call").pipe(
      Effect.annotateLogs({ operation: request.operation, outcome }),
    )
    if (sent._tag === "Failure") return yield* writeFailure(sent.failure)
    return { ...call, outcome: { _tag: "Success" as const, value: { writeId: request.request, branchId: request.branchId } } }
  }).pipe(Effect.withSpan("branch.operation.call"))

/** Runs the operation as a child of the caller's durable step, under an identity every retry of the step shares. */
export const run = (request: OperationRequest) =>
  Effect.gen(function* () {
    return yield* (yield* FlowRuntime.FlowRuntime).execute(OperationStart, {
      executionId: `branch-operation:${request.request}`,
      payload: request,
    }).pipe(
      Effect.catchDefect(() => Effect.fail(new BranchTrackUnavailable())),
      Effect.mapError((error) =>
        error instanceof BranchTrackRefused || error instanceof BranchTrackUnavailable ? error : new BranchTrackUnavailable()
      ),
    )
  })

/**
 * The registry step: the write's id (version 5 of the run's execution in the conversation namespace, as `/new` derives
 * its request), the branch as the person may open it, then the operation.
 */
const operate = (
  operation: "publish" | "update",
  request: { readonly repo: string; readonly branch: string; readonly title?: string; readonly body?: string | undefined },
) =>
  Effect.gen(function* () {
    const { executionId } = yield* FlowRuntime.FlowInstance
    const writeId = yield* Uuid.v5(CONVERSATION_NAMESPACE, `${operation}:${executionId}`).pipe(Effect.orDie)
    const tracked = yield* requestTrack({ repo: request.repo, branch: request.branch })
    const [owner, name] = parts(request.repo)
    return yield* run({
      owner,
      name,
      branchId: tracked.branchId,
      operation,
      ...(request.title === undefined ? {} : { title: request.title }),
      ...(request.body === undefined ? {} : { body: request.body }),
      request: writeId,
    })
  }).pipe(Effect.withSpan(`branch.${operation}`))

/** `branch/publish/request`. */
export const requestPublish = (request: typeof PublishRequest.payloadSchema.Type) =>
  operate("publish", { ...request, body: request.body ?? "" })

/** `branch/update/request`. */
export const requestUpdate = (request: typeof UpdateRequest.payloadSchema.Type) => operate("update", request)

/**
 * `branch/resync/request`: the write's id as `operate` derives one, the branch as the person may open it, and the write,
 * sent under that id so every retry sends the same one.
 */
export const requestResync = (request: typeof ResyncRequest.payloadSchema.Type) =>
  Effect.gen(function* () {
    const { executionId } = yield* FlowRuntime.FlowInstance
    const writeId = yield* Uuid.v5(CONVERSATION_NAMESPACE, `resync:${executionId}`).pipe(Effect.orDie)
    const tracked = yield* requestTrack({ repo: request.repo, branch: request.branch })
    const [owner, name] = parts(request.repo)
    const sent = yield* Effect.result(
      (yield* BranchWrites).send(owner, name, { writeId, op: "branch/resync", branchId: tracked.branchId }),
    )
    const outcome = sent._tag === "Success" ? "sent" : (() => {
      const failure = writeFailure(sent.failure)
      return failure._tag === "@smthrs/mvp/branch/BranchTrackRefused" ? failure.reason : "unavailable"
    })()
    yield* Metric.update(Metric.withAttributes(steps, { operation: "resync", outcome }), 1)
    yield* Effect.logWithLevel(sent._tag === "Success" ? "Info" : "Warn")("branch.operation.call").pipe(
      Effect.annotateLogs({ operation: "resync", outcome }),
    )
    if (sent._tag === "Failure") return yield* writeFailure(sent.failure)
    return { writeId, branchId: tracked.branchId }
  }).pipe(Effect.withSpan("branch.resync"))

/**
 * Registers `branch/publish`, `branch/update`, `branch/resync` and the selection lineage the first two run, asking
 * ChatApi on `origin`. Needs the host's `HttpClient`.
 */
export const registrationAt = (origin: string) =>
  Layer.mergeAll(
    Interpreter.layerWithImplementations(BranchPublish, PublishRequest.toLayer(requestPublish)),
    Interpreter.layerWithImplementations(BranchUpdate, UpdateRequest.toLayer(requestUpdate)),
    Interpreter.layerWithImplementations(BranchResync, ResyncRequest.toLayer(requestResync)),
    Layer.unwrap(Effect.map(HttpClient.HttpClient, (client) =>
      Interpreter.layerWithImplementations(
        OperationStart,
        SelectOperation.toLayer((request) => select(origin)(request).pipe(Effect.provideService(HttpClient.HttpClient, client))),
      ))),
    Interpreter.layerWithImplementations(
      OperationProgram,
      Layer.mergeAll(
        EvaluateOperation.toLayer(evaluate).pipe(Layer.provide(RealmFlow.layerDefaultVariant)),
        CallOperation.toLayer(call),
      ),
    ),
  ).pipe(Layer.provide(BranchClient.layer({ origin })), Layer.provide(BranchWrites.layer({ origin })))
