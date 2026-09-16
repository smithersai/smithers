/** Proof comes from this host's existing approved control and engine ancestry. */
import { ControlRuntime } from "@smthrs/control/ControlRuntime"
import * as Digest from "@smthrs/core/Digest"
import { DurableEngineState } from "@smthrs/engine-store"
import * as RunCatalogRead from "@smthrs/engine-store/RunCatalogRead"
import { RunState } from "@smthrs/engine-store/RunState"
import * as RunStore from "@smthrs/run-store/RunStore"
import { Flow } from "@smthrs/flow"
import { Effect, Exit, Option, Schema } from "effect"
import { CodingError } from "../coding/schema.ts"
import { JobInput, JobResult, OperationResult, SetupInput } from "./schema.ts"
import { RepositoryJob } from "./jobs.ts"

const invalid = (message: string) => new CodingError({ code: "invalid_receipt", message })
const record = (value: unknown): Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {}
export const readOwnedResult = <S extends Schema.Top & { readonly DecodingServices: never }, E extends Schema.Top & { readonly DecodingServices: never }>(
  executionId: string, flow: string, bridge: string, payload: unknown, success: S, error: E
) => Effect.gen(function*() {
  const store = yield* RunStore.RunStore, graph = yield* DurableEngineState.DurableEngineState, control = yield* ControlRuntime
  let bytes = 0
  const read = (id: string) => Effect.gen(function*() {
    const row = yield* store.get(id)
    bytes += row.stateJson.length
    if (row.runId !== id || row.status !== "completed" || row.stateJson.length > 8 * 1024 * 1024 || bytes > 24 * 1024 * 1024) return yield* invalid("The completed receipt or its ancestry is unavailable")
    const state = Schema.decodeUnknownOption(Schema.fromJsonString(RunState))(row.stateJson)
    if (Option.isNone(state) || state.value.cancellation !== undefined) return yield* invalid("The receipt has invalid or cancelled native state")
    return { row, state: state.value }
  })
  const selected = yield* read(executionId)
  if (selected.state.flowName !== flow || Digest.canonical(selected.state.payload) !== Digest.canonical(payload)) return yield* invalid("The receipt does not match its claimed flow and input")
  const result = Schema.decodeUnknownOption(Schema.toCodecJson(Flow.Result({ success, error })))(selected.state.result)
  if (Option.isNone(result) || result.value._tag !== "Complete" || Exit.isFailure(result.value.exit)) return yield* invalid("The native flow did not complete successfully")
  const visited = new Set<string>()
  let id = executionId, bridged = false
  while (visited.size < 128) {
    if (visited.has(id)) return yield* invalid("Native receipt ancestry contains a cycle")
    visited.add(id)
    const entry = id === executionId ? selected : yield* read(id)
    if (entry.state.flowName === bridge) {
      if (bridged || Digest.canonical(record(entry.state.payload).input) !== Digest.canonical(payload)) return yield* invalid("The registered bridge does not match the receipt")
      bridged = true
    }
    const parents = yield* graph.runParents(id)
    const root = yield* control.getRun(id).pipe(Effect.map(Option.some), Effect.catchTag("/control/RunNotFound", () => Effect.succeedNone))
    if (Option.isSome(root)) {
      const run = root.value
      if (!bridged || parents.length !== 0 || entry.state.parentExecutionId !== undefined || entry.state.flowName !== "agent/run" ||
          run.status !== "completed" || run.flowId !== bridge || !run.planId || record(entry.state.payload).planId !== run.planId) return yield* invalid("The receipt has no single completed control owner")
      const plan = yield* control.getPlan(run.planId)
      if (plan.decision !== "approved" || run.planDigest !== plan.card.digest || plan.card.flowId !== bridge ||
          Digest.canonical(plan.decodedInput) !== Digest.canonical(payload)) return yield* invalid("The receipt differs from its approved input")
      return { output: result.value.exit.value, run, plan }
    }
    if (parents.length > 1) return yield* invalid("The receipt has ambiguous native ownership")
    const parent = parents[0]?.parentId ?? entry.row.parentRunId
    if (!parent || (entry.state.parentExecutionId !== undefined && entry.state.parentExecutionId !== parent)) return yield* invalid("The receipt has no retained native owner")
    id = parent
  }
  return yield* invalid("The receipt ancestry exceeds its bounded lookup")
})

export const priorSetupReceipt = (input: SetupInput, operation: "evaluate" | "trial") => Effect.gen(function*() {
  const catalog = yield* RunCatalogRead.RunCatalogRead, store = yield* RunStore.RunStore
  const page = yield* catalog.listRuns({ filters: { flowName: "repository/Setup" }, limit: 100 })
  for (const candidate of page.runs) {
    const row = yield* store.get(candidate.runId)
    if (row.status !== "completed" || row.stateJson.length > 8 * 1024 * 1024) continue
    const state = Schema.decodeUnknownOption(Schema.fromJsonString(RunState))(row.stateJson)
    if (Option.isNone(state)) continue
    const payload = Schema.decodeUnknownOption(SetupInput)(state.value.payload)
    if (Option.isNone(payload) || payload.value.repo !== input.repo || payload.value.job !== input.job || payload.value.digest !== input.digest ||
        payload.value.revision !== input.revision || payload.value.operation !== operation) continue
    const proof = yield* readOwnedResult(candidate.runId, "repository/Setup", "repository/setup", payload.value, OperationResult, CodingError)
    const receipt = proof.output.receipt
    if (receipt?.phase === "completed" && receipt.operation === operation && receipt.digest === input.digest && receipt.revision === input.revision && receipt.runId === proof.run.runId) return receipt
  }
  return yield* invalid(`Run ${operation === "evaluate" ? "evals" : "the live trial"} for this exact candidate before continuing`)
})

export const completedJob = (runId: string, input: Pick<JobInput, "repo" | "job" | "revision" | "digest"> & { sourceRevision?: string },
  event: { source: "github" | "smithers-cloud"; issueNumber: number; deliveryKey?: string; manualStep?: string; trial?: boolean }) => Effect.gen(function*() {
  const control = yield* ControlRuntime, catalog = yield* RunCatalogRead.RunCatalogRead, store = yield* RunStore.RunStore
  const root = yield* control.getRun(runId)
  if (root.status === "failed" || root.status === "cancelled") return yield* invalid("The live job failed or was stopped; inspect its run before retrying")
  if (root.status !== "completed") return undefined
  const page = yield* catalog.listRuns({ filters: { flowName: RepositoryJob._tag }, limit: 100 })
  for (const row of page.runs) {
    const stored = yield* store.get(row.runId)
    if (stored.status !== "completed" || stored.stateJson.length > 8 * 1024 * 1024) continue
    const state = Schema.decodeUnknownOption(Schema.fromJsonString(RunState))(stored.stateJson)
    if (Option.isNone(state)) continue
    const payload = Schema.decodeUnknownOption(JobInput)(state.value.payload)
    if (Option.isNone(payload)) continue
    const value = payload.value
    if (value.repo !== input.repo || value.job !== input.job || value.digest !== input.digest || value.revision !== input.revision ||
        (input.sourceRevision !== undefined && value.sourceRevision !== input.sourceRevision) || value.event.source !== event.source ||
        (value.event.issueNumber ?? 0) !== event.issueNumber || (event.deliveryKey !== undefined && value.event.deliveryKey !== event.deliveryKey) ||
        value.event.manualStep !== event.manualStep || (event.trial === true && value.event.trial !== true)) continue
    const proof = yield* readOwnedResult(row.runId, RepositoryJob._tag, `repository-jobs/${input.job}`, value, JobResult, RepositoryJob.errorSchema)
    if (proof.run.runId !== runId) continue
    if (proof.output.repo !== value.repo || proof.output.job !== value.job || proof.output.revision !== value.revision || proof.output.digest !== value.digest ||
        proof.output.eventKey !== value.event.deliveryKey || proof.output.status !== "completed" || proof.output.results.length === 0 ||
        proof.output.results.some(step => step.status !== "completed") || (event.manualStep !== undefined &&
          (proof.output.results.length !== 1 || proof.output.results[0]!.stepId !== event.manualStep))) {
      return yield* invalid("The live job did not complete its selected work; inspect the actual results")
    }
    return { ...proof, executionId: row.runId }
  }
  return yield* invalid("The completed live run has no matching native repository job receipt")
})
