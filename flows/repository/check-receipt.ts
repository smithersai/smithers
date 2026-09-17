/** The reserved CI receipt Plue's landing gate reads, re-derived from durable native state. */
import { ControlRuntime } from "@smthrs/control/ControlRuntime"
import { DurableEngineState } from "@smthrs/engine-store"
import { RunState } from "@smthrs/engine-store/RunState"
import { Flow } from "@smthrs/flow"
import * as RunStore from "@smthrs/run-store/RunStore"
import { Cause, Context, Effect, Exit, Layer, Option, Schema, Stream } from "effect"
import { FetchHttpClient, HttpClient, HttpClientRequest, type HttpClientResponse } from "effect/unstable/http"
import { ChangeId, Resolved, SourcePublication } from "../coding/native-schema.ts"
import { CodingError } from "../coding/schema.ts"
import { CheckOutput, CheckStep } from "./checks.ts"
import { StepResult } from "./schema.ts"

const invalid = (message: string) => new CodingError({ code: "invalid_receipt", message })
const unavailable = (message: string) => new CodingError({ code: "unavailable", message })
const replaced = (message: string) => new CodingError({ code: "stale_revision", message })
const uncovered = (message: string) => new CodingError({ code: "fast_gate", message })
const record = (value: unknown): Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {}
const CommitId = Resolved.fields.commitId, Uuid = SourcePublication.fields.requestId
const PositiveId = Schema.Int.check(Schema.isGreaterThan(0), Schema.isLessThanOrEqualTo(Number.MAX_SAFE_INTEGER))
const Sha256 = Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/))
/** Owned by the policy lane; this host only consumes the pinned identity. */
export const CiPolicyRef = Schema.Struct({ repositoryId: PositiveId, registrationId: Uuid, revision: PositiveId,
  digest: Sha256, executionDigest: Sha256, requiredCheckIds: Schema.Array(Schema.NonEmptyString).check(Schema.isMaxLength(200)) })
export const CiPolicy = Schema.Union([Schema.Struct({ kind: Schema.Literal("none") }),
  Schema.Struct({ kind: Schema.Literal("pinned"), ref: CiPolicyRef, checks: Schema.Array(Schema.Unknown) })])
export const CheckOutcome = Schema.Struct({ id: Schema.NonEmptyString.check(Schema.isMaxLength(100)),
  outcome: Schema.Literals(["passed", "skipped_no_matching_paths"]) })
export const CheckReceiptRequest = Schema.Struct({ repo: Schema.NonEmptyString, workspace_id: Uuid, registration_id: Uuid,
  revision: PositiveId, digest: Sha256, execution_digest: Sha256, run_id: Schema.NonEmptyString, execution_id: Schema.NonEmptyString,
  commit_id: CommitId, change_id: ChangeId, base_commit_id: CommitId,
  checks: Schema.Array(CheckOutcome).check(Schema.isMinLength(1), Schema.isMaxLength(200)), gate: Schema.Literal("passed") })
export const CheckReceipt = Schema.Struct({ request_id: Uuid, context: Schema.NonEmptyString.check(Schema.isMaxLength(255)),
  commit_id: CommitId, status: Schema.Literal("success"), status_id: PositiveId })
export class RepositoryCheckReceipts extends Context.Service<RepositoryCheckReceipts, {
  /** An absent pinned policy is authoritative "no policy"; an unreadable one is an error. */
  readonly policy: (work: unknown) => Effect.Effect<typeof CiPolicy.Type, CodingError>
  readonly rawCheckId: (inheritedId: string) => string | undefined
  readonly report: (requestId: string, input: typeof CheckReceiptRequest.Type) => Effect.Effect<typeof CheckReceipt.Type, CodingError>
}>()("repository/CheckReceipts") {}

/** Trusted provisioned gateway binding, never workflow or model input. */
export interface Options {
  readonly apiBaseUrl: string
  readonly gatewayId: string
  readonly credential: string
  readonly repositorySlug: string
  readonly workspaceId: string
  /** The policy lane owns inherited-id namespacing; an unnamespaced id is its own raw id. */
  readonly rawCheckId?: (inheritedId: string) => string | undefined
}

const maximumBodyBytes = 256 * 1024
const readJson = (response: HttpClientResponse.HttpClientResponse) => Effect.gen(function*() {
  const declared = response.headers["content-length"]
  if (declared !== undefined && (!/^\d+$/.test(declared) || !Number.isSafeInteger(Number(declared)) || Number(declared) > maximumBodyBytes)) {
    return yield* invalid("The CI receipt response exceeds its bounded size")
  }
  const decoder = new TextDecoder("utf-8", { fatal: true })
  const captured = yield* Stream.runFoldEffect(response.stream, () => ({ bytes: 0, text: "" }), (state, chunk) => Effect.try({
    try: () => {
      if (state.bytes + chunk.length > maximumBodyBytes) throw new Error("bound")
      return { bytes: state.bytes + chunk.length, text: state.text + decoder.decode(chunk, { stream: true }) }
    }, catch: () => invalid("The CI receipt response is invalid or exceeds its bounded size")
  })).pipe(Effect.mapError(error => error instanceof CodingError ? error : unavailable("The CI receipt response could not be read")))
  return yield* Effect.try({ try: () => JSON.parse(captured.text + decoder.decode()) as unknown,
    catch: () => invalid("The CI receipt store returned no valid JSON receipt") })
})

/** The gateway credential proves this workspace, never the repository landing token. */
export const make = (options: Options) => Effect.gen(function*() {
  const client = yield* HttpClient.HttpClient
  const url = yield* Effect.try({ try: () => new URL(options.apiBaseUrl), catch: () => unavailable("The CI receipt binding is invalid") })
  if (!/^https?:$/.test(url.protocol) || url.username || url.password || url.search || url.hash ||
    !url.pathname.endsWith("/api") || options.apiBaseUrl !== url.href.replace(/\/$/, "") ||
    !Schema.is(Uuid)(options.gatewayId) || !Schema.is(Uuid)(options.workspaceId) ||
    !options.credential.trim() || /[\r\n]/.test(options.credential)) {
    return yield* unavailable("The CI receipt requires the exact provisioned gateway, API and credential binding")
  }
  const report = (requestId: string, input: typeof CheckReceiptRequest.Type) => Effect.gen(function*() {
    const body = yield* Schema.encodeEffect(CheckReceiptRequest)(input).pipe(
      Effect.mapError(() => invalid("The CI receipt does not name an exact checked source")))
    if (!Schema.is(Uuid)(requestId)) return yield* invalid("The CI receipt needs a stable request identity")
    const response = yield* HttpClient.withScope(client).execute(HttpClientRequest.put(
      `${options.apiBaseUrl}/gateways/${options.gatewayId}/repository-jobs/ci/check-receipts/${requestId}`).pipe(
        request => HttpClientRequest.bodyJsonUnsafe(request, body as object),
        HttpClientRequest.bearerToken(options.credential), HttpClientRequest.acceptJson))
      .pipe(Effect.mapError(() => unavailable("The CI receipt store could not be reached; retry the same durable request")))
    if (response.status !== 200 && response.status !== 201) {
      // Never expose remote bodies; the status alone names the cause.
      if (response.status === 409) return yield* replaced("The pinned repository CI policy changed before this receipt; replan under the current policy")
      if (response.status === 404) return yield* replaced("The pinned repository CI policy no longer exists; replan under the current policy")
      if (response.status === 422) return yield* uncovered("The checked results do not cover every required repository CI check")
      if (response.status === 503) return yield* unavailable("The CI receipt store is unavailable; retry the same durable request")
      return yield* invalid(`The CI receipt was refused for this workspace binding (HTTP ${response.status})`)
    }
    const receipt = yield* readJson(response).pipe(Effect.flatMap(Schema.decodeUnknownEffect(CheckReceipt)),
      Effect.mapError(error => error instanceof CodingError ? error : invalid("The CI receipt does not match the required protocol")))
    if (receipt.request_id !== requestId || receipt.commit_id !== input.commit_id ||
      receipt.context !== `repository-ci/${input.registration_id}@${input.revision}.${input.digest.slice(0, 12)}`) {
      return yield* invalid("The CI receipt identifies another request, source or policy")
    }
    return receipt
  }).pipe(Effect.provideService(FetchHttpClient.RequestInit, { redirect: "manual" }), Effect.scoped,
    Effect.timeoutOrElse({ duration: "90 seconds", orElse: () => Effect.fail(unavailable("The CI receipt store exceeded its request deadline; retry the same durable request")) }),
    Effect.catchCause(cause => {
      if (Cause.hasInterruptsOnly(cause)) return Effect.failCause(cause)
      const error = Cause.squash(cause)
      return Effect.fail(error instanceof CodingError ? error : unavailable("The CI receipt request failed before a receipt could be verified"))
    }))
  return RepositoryCheckReceipts.of({ report, rawCheckId: options.rawCheckId ?? (id => id),
    policy: work => record(work).ciPolicy === undefined ? Effect.succeed({ kind: "none" as const })
      : Schema.decodeUnknownEffect(CiPolicy)(record(work).ciPolicy).pipe(
        Effect.mapError(() => invalid("The pinned repository CI policy is unreadable; inspect this job before landing"))) })
})
export const layer = (options: Options) => Layer.effect(RepositoryCheckReceipts)(make(options))

export interface VerifiedCheckStep {
  readonly runId: string
  readonly executionId: string
  readonly candidate: string
  readonly checks: ReadonlyArray<typeof CheckOutcome.Type>
}
const reserved = (flowId: string) => /^repository-jobs\/(issues|review|ci|feature|chores)$/.test(flowId)
const outcomes = (output: typeof CheckOutput.Type, ref: typeof CiPolicyRef.Type, rawCheckId: (id: string) => string | undefined) => {
  const checks: Array<typeof CheckOutcome.Type> = []
  for (const result of output.results) {
    const id = rawCheckId(result.checkId)
    if (id === undefined) continue
    if (result.status === "passed") checks.push({ id, outcome: "passed" })
    else if (result.status === "skipped" && !output.results.some(other => other.policy === "required" && (other.status === "failed" || other.status === "error"))) {
      checks.push({ id, outcome: "skipped_no_matching_paths" })
    }
  }
  if (!checks.length || checks.length > 200 || new Set(checks.map(check => check.id)).size !== checks.length) {
    throw invalid("The checked results carry no unique bounded check identities")
  }
  for (const required of ref.requiredCheckIds) {
    const id = rawCheckId(required) ?? required
    if (!checks.some(check => check.id === id)) throw uncovered(`Required repository CI check ${id} has no passed or out-of-scope result`)
  }
  return checks
}

/** Proof comes from this host's durable engine, control and run stores, never
 * from the step output the delivering job happens to be carrying. */
export const verifiedCheckStep = (input: { readonly executionId: string; readonly commitId: string
  readonly ref: typeof CiPolicyRef.Type; readonly rawCheckId: (inheritedId: string) => string | undefined }) => Effect.gen(function*() {
  const connected = yield* Effect.all([Effect.serviceOption(RunStore.RunStore), Effect.serviceOption(DurableEngineState.DurableEngineState), Effect.serviceOption(ControlRuntime)])
  if (Option.isNone(connected[0]) || Option.isNone(connected[1]) || Option.isNone(connected[2])) {
    return yield* unavailable("The check receipt stores are not connected to this host")
  }
  const store = connected[0].value, graph = connected[1].value, control = connected[2].value
  let bytes = 0
  const read = (id: string) => Effect.gen(function*() {
    const row = yield* store.get(id).pipe(Effect.mapError(error => error instanceof RunStore.RunStoreError && error.code === "not_found_row"
      ? invalid("The claimed check execution or its ancestry is not retained by this host")
      : unavailable("The check receipt stores are unavailable; retry the same durable request")))
    bytes += row.stateJson.length
    if (row.runId !== id || row.status === "failed" || row.status === "cancelled" || row.stateJson.length > 8 * 1024 * 1024 || bytes > 24 * 1024 * 1024) {
      return yield* invalid("The checked execution or its ancestry failed, was stopped, or exceeds its bounded lookup")
    }
    const state = Schema.decodeUnknownOption(Schema.fromJsonString(RunState))(row.stateJson)
    if (Option.isNone(state) || state.value.cancellation !== undefined) return yield* invalid("The checked execution has invalid or cancelled native state")
    return { row, state: state.value }
  })
  const selected = yield* read(input.executionId)
  if (selected.row.status !== "completed" || selected.state.flowName !== CheckStep._tag) return yield* invalid("The claimed execution is not a completed repository check step")
  const decoded = Schema.decodeUnknownOption(Schema.toCodecJson(Flow.Result({ success: StepResult, error: CodingError })))(selected.state.result)
  if (Option.isNone(decoded) || decoded.value._tag !== "Complete" || Exit.isFailure(decoded.value.exit)) return yield* invalid("The check step did not complete successfully")
  const output = Schema.decodeUnknownOption(CheckOutput)(decoded.value.exit.value.output)
  if (Option.isNone(output) || output.value.gate !== "passed" || output.value.candidate !== input.commitId) {
    return yield* invalid("The durable check result does not pass on this exact delivered source")
  }
  const policy = Schema.decodeUnknownOption(CiPolicy)(record(record(selected.state.payload).work).ciPolicy)
  if (Option.isNone(policy) || policy.value.kind !== "pinned" || policy.value.ref.registrationId !== input.ref.registrationId ||
      policy.value.ref.revision !== input.ref.revision || policy.value.ref.digest !== input.ref.digest ||
      policy.value.ref.executionDigest !== input.ref.executionDigest) return yield* replaced("The checks ran under another repository CI policy; recheck under the pinned policy")
  const checks = yield* Effect.try({ try: () => outcomes(output.value, input.ref, input.rawCheckId),
    catch: error => error instanceof CodingError ? error : invalid("The durable check results could not be read") })
  const visited = new Set<string>()
  let id = input.executionId
  while (visited.size < 128) {
    if (visited.has(id)) return yield* invalid("The checked execution ancestry contains a cycle")
    visited.add(id)
    const entry = id === input.executionId ? selected : yield* read(id)
    const owner = yield* control.getRun(id).pipe(Effect.map(Option.some),
      Effect.catchTag("/control/RunNotFound", () => Effect.succeedNone),
      Effect.mapError(() => unavailable("The control run store is unavailable; retry the same durable request")))
    if (Option.isSome(owner)) {
      const run = owner.value
      if (run.status === "failed" || run.status === "cancelled" || run.cancellation !== undefined || !run.planId || !reserved(run.flowId)) {
        return yield* invalid("The checked execution has no live reserved repository job owner")
      }
      const plan = yield* control.getPlan(run.planId).pipe(Effect.mapError(() => unavailable("The control plan store is unavailable; retry the same durable request")))
      if (plan.decision !== "approved" || run.planDigest !== plan.card.digest || plan.card.flowId !== run.flowId) {
        return yield* invalid("The checked execution has no approved control plan")
      }
      return { runId: run.runId, executionId: input.executionId, candidate: output.value.candidate, checks } satisfies VerifiedCheckStep
    }
    const parents = yield* graph.runParents(id)
    if (parents.length > 1) return yield* invalid("The checked execution has ambiguous native ownership")
    const parent = parents[0]?.parentId ?? entry.row.parentRunId
    if (!parent || (entry.state.parentExecutionId !== undefined && entry.state.parentExecutionId !== parent)) {
      return yield* invalid("The checked execution has no retained native owner")
    }
    id = parent
  }
  return yield* invalid("The checked execution ancestry exceeds its bounded lookup")
}).pipe(Effect.mapError(error => error instanceof CodingError ? error : unavailable("The check receipt stores are unavailable; retry the same durable request")))
