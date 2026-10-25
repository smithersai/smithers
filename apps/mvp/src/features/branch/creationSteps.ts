import { digestSync, Uuid } from "@smthrs/crypto"
import { FlowRuntime, Interpreter } from "@smthrs/flow"
import { RealmFlow } from "@smthrs/harness"
import { Effect, Layer, Metric, Schema } from "effect"
import { HttpClient, HttpClientRequest } from "effect/http"
import { CREATION_ROUTE, CreationSelection } from "./creation"
import { BranchClient, TRACK_WITHIN } from "./api"
import { CONVERSATION_NAMESPACE, isBranchName } from "./contract"
import { BranchTrackRefused, BranchTrackUnavailable } from "./flows"
import { CallCreation, CreationProgram, type CreationRequest, CreationStart, EvaluateCreation, SelectCreation } from "./creationFlows"
import { Tracked } from "./schema"

const invalid = () => new BranchTrackRefused({ reason: "invalid" })
export const executions = Metric.counter("smithers_branch_creation_steps", { incremental: true })

/**
 * The authenticated route resolves the repository's manifest and source at one commit, for the operation `query` names
 * (creation unless it names one; docs/features/branch-publish.md), and the home repository unless it names one.
 */
export const selection = (origin: string, query: Readonly<Record<string, string>>) => Effect.gen(function* () {
  const client = yield* HttpClient.HttpClient
  const response = yield* client.execute(HttpClientRequest.get(`${origin}${CREATION_ROUTE}`).pipe(
    HttpClientRequest.setUrlParams(query),
  )).pipe(Effect.mapError(() => new BranchTrackUnavailable()))
  if (response.status === 401) return yield* new BranchTrackRefused({ reason: "sign_in" })
  if (response.status === 403) return yield* new BranchTrackRefused({ reason: "forbidden" })
  if (response.status === 404) return yield* new BranchTrackRefused({ reason: "not_found" })
  if (response.status === 400 || response.status === 413) return yield* new BranchTrackRefused({ reason: "invalid" })
  if (response.status !== 200) return yield* new BranchTrackUnavailable()
  return yield* response.json.pipe(Effect.flatMap(Schema.decodeUnknownEffect(CreationSelection)), Effect.mapError(() => new BranchTrackUnavailable()))
}).pipe(Effect.timeoutOrElse({ duration: TRACK_WITHIN, orElse: () => Effect.fail(new BranchTrackUnavailable()) }))

/** Creation's selection: the request's repository, the home one when it names none. */
export const select = (origin: string) => (request: CreationRequest) =>
  selection(origin, request.owner === undefined ? {} : { owner: request.owner, name: request.name! })

/** No output is accepted as a created conversation without a matching host write receipt. */
export const evaluate = (state: typeof EvaluateCreation.payloadSchema.Type) => Effect.gen(function* () {
  if (state.selection.runtime !== RealmFlow.version || digestSync(state.selection.source) !== state.selection.digest || state.receipts.length > 1) return yield* invalid()
  const result = yield* RealmFlow.step({
    source: state.selection.source, expectedTag: state.selection.tag, payload: { ref: state.request.ref },
    allowedActions: state.selection.allowed, receipts: state.receipts,
  }).pipe(Effect.mapError(invalid))
  yield* Metric.update(Metric.withAttributes(executions, { outcome: result._tag }), 1)
  yield* Effect.logInfo("branch.creation.evaluate").pipe(Effect.annotateLogs({ outcome: result._tag }))
  if (result._tag === "Action") {
    if (state.receipts.length !== 0) return yield* invalid()
    return result
  }
  const receipt = state.receipts[0]
  if (receipt?.outcome._tag !== "Success") return yield* invalid()
  const recorded = yield* Schema.decodeUnknownEffect(Tracked)(receipt.outcome.value).pipe(Effect.mapError(invalid))
  const value = yield* Schema.decodeUnknownEffect(Tracked)(result.value).pipe(Effect.mapError(invalid))
  if (Object.keys(Tracked.fields).some((key) => value[key as keyof Tracked] !== recorded[key as keyof Tracked])) return yield* invalid()
  return { _tag: "Complete" as const, value }
}).pipe(Effect.withSpan("branch.creation.evaluate"))

/** The plugin supplies a branch name; the host fixes repository, request identity and permissions. */
export const call = ({ state, call }: typeof CallCreation.payloadSchema.Type) => Effect.gen(function* () {
  const payload = yield* Schema.decodeUnknownEffect(Schema.Struct({ ref: Schema.String }))(call.payload).pipe(Effect.mapError(invalid))
  if (!isBranchName(payload.ref) || !state.selection.allowed.includes(call.name) || (call.name !== "branches/ephemeral" && call.name !== "branches/github")) return yield* invalid()
  const made = yield* (yield* BranchClient).track({
    owner: state.selection.owner, name: state.selection.name, ref: payload.ref, create: true,
    request: state.request.request, ...(call.name === "branches/github" ? { provider: "github" as const } : {}), ...(state.request.openedAt === undefined ? {} : { openedAt: state.request.openedAt }),
  }).pipe(Effect.mapError((error) => error.status === 403 ? new BranchTrackRefused({ reason: "forbidden" })
    : error.status === 404 ? new BranchTrackRefused({ reason: "not_found" })
    : error.status === 401 ? new BranchTrackRefused({ reason: "sign_in" })
    : error.status === 409 ? new BranchTrackRefused({ reason: "exists" })
    : error.status === 400 || error.status === 413 ? invalid()
    : error.code === "not_configured" ? new BranchTrackRefused({ reason: "not_configured" })
    : new BranchTrackUnavailable()))
  return { ...call, outcome: { _tag: "Success" as const, value: made } }
})

export const registration = (origin: string) => Layer.mergeAll(
  Layer.unwrap(Effect.map(HttpClient.HttpClient, (client) => Interpreter.layerWithImplementations(CreationStart,
    SelectCreation.toLayer((request) => select(origin)(request).pipe(Effect.provideService(HttpClient.HttpClient, client))),
  ))),
  Interpreter.layerWithImplementations(CreationProgram, Layer.mergeAll(
    EvaluateCreation.toLayer(evaluate).pipe(Layer.provide(RealmFlow.layerDefaultVariant)),
    CallCreation.toLayer(call),
  )),
)

/** Run as a child of the caller's durable step, with a stable identity across its retries. */
export const run = (request: Omit<CreationRequest, "request"> & { readonly request?: string }) => Effect.gen(function* () {
  const { executionId } = yield* FlowRuntime.FlowInstance
  const requestId = request.request ?? (yield* Uuid.v5(CONVERSATION_NAMESPACE, executionId).pipe(Effect.orDie))
  return yield* (yield* FlowRuntime.FlowRuntime).execute(CreationStart, { executionId: `branch-creation:${requestId}`, payload: { ...request, request: requestId } }).pipe(Effect.catchDefect(() => Effect.fail(new BranchTrackUnavailable())), Effect.mapError((error) => error instanceof BranchTrackRefused || error instanceof BranchTrackUnavailable ? error : new BranchTrackUnavailable()))
})
