import * as Digest from "@smthrs/core/Digest"
import { Option, Schema } from "effect"
import { RequestInput, RequestResult } from "../../../../../flows/coding/schema.ts"
import { PublicationInput, VibeAdmission, VibeCleanup, VibeInput } from "../../../../../flows/coding/vibe-schema.ts"
import { SourcePublication } from "../../../../../flows/coding/native-schema.ts"
import type { Card } from "../state/AppState"
import { codingEvidenceOf } from "./CodingPlan"
import { engineRunEvidence, type EngineExecutionEvidence } from "./EngineTrace"

export type WorkflowCatalog = Extract<Card, { kind: "workflow-list" }>
type RunCard = Extract<Card, { kind: "run-trace" }>
const requestInput = Schema.decodeUnknownOption(RequestInput)
const requestResult = Schema.decodeUnknownOption(RequestResult)
const vibeInput = Schema.decodeUnknownOption(VibeInput)
const vibeAdmission = Schema.decodeUnknownOption(VibeAdmission)
const vibeCleanup = Schema.decodeUnknownOption(VibeCleanup)
const publicationInput = Schema.decodeUnknownOption(PublicationInput)
const sourcePublication = Schema.decodeUnknownOption(SourcePublication)
const object = (value: unknown): Readonly<Record<string, unknown>> | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? value as Readonly<Record<string, unknown>> : undefined

/** The native descriptor bridge is recorded separately; its delegate may be inlined. */
const nativeOwner = (execution: EngineExecutionEvidence, executions: ReadonlyArray<EngineExecutionEvidence>,
  rootId: string, bridgeName: string, input: unknown, decodeInput: (value: unknown) => Option.Option<unknown>,
  requireCompleted: boolean): boolean => {
  let current: EngineExecutionEvidence | undefined = execution
  let bridges = 0
  const visited = new Set<string>()
  while (current !== undefined && visited.size < 1024 && !visited.has(current.executionId)) {
    visited.add(current.executionId)
    if (requireCompleted && current.status !== "completed") return false
    if (current.flowName === bridgeName) {
      bridges++
      const decoded = decodeInput(object(current.input)?.input)
      if (Option.isNone(decoded) || Digest.canonical(decoded.value) !== Digest.canonical(input)) return false
    }
    if (current.executionId === rootId) {
      return bridges === 1 && current.flowName === "agent/run" && current.parentExecutionId === undefined &&
        typeof object(current.input)?.planId === "string" && String(object(current.input)?.planId).length > 0
    }
    current = executions.find(candidate => candidate.executionId === current!.parentExecutionId)
  }
  return false
}

/** Render-only invitation, never an authority to finalize or a claim of landing. */
export const codingVibeRequestOf = (card: RunCard): { readonly requestExecutionId: string; readonly spanId: string } | undefined => {
  if (card.payload.workflow !== "coding/request" || card.payload.phase !== "completed") return undefined
  const evidence = engineRunEvidence(card.payload.events ?? [], card.payload.runId, card.payload.cursorSeq)
  const requests = evidence.executions.filter(execution => execution.flowName === "coding/Request")
  if (requests.length !== 1) return undefined
  const request = requests[0]!
  const input = requestInput(request.input)
  const result = requestResult(request.result?.value)
  const projected = codingEvidenceOf(card)
  if (request.status !== "completed" || Option.isNone(input) || Option.isNone(result) ||
    result.value.outcome.status !== "validated" || result.value.outcome.blocked !== null ||
    result.value.outcome.result?.status !== "validated" || result.value.outcome.result.findings.length !== 0 ||
    projected.plan === undefined || projected.outcome?.status !== "validated" ||
    Digest.canonical(projected.plan) !== Digest.canonical(result.value.plan) ||
    !nativeOwner(request, evidence.executions, card.payload.runId, "coding/request", input.value, requestInput, true)) return undefined
  return { requestExecutionId: request.executionId, spanId: request.spanId }
}

/** Only a catalog actually read from this retained gateway supplies availability. */
export const codingVibeAvailable = (card: RunCard, catalogs: ReadonlyArray<WorkflowCatalog>): boolean => {
  const matching = catalogs.filter(catalog => catalog.payload.gatewayBindingVersion === 1 &&
    catalog.payload.repo === card.payload.repo && catalog.payload.workspaceId === card.payload.workspaceId)
    .sort((left, right) => right.ordinal - left.ordinal)
  const latest = matching[0]
  return latest !== undefined && matching[1]?.ordinal !== latest.ordinal &&
    latest.payload.workflows.some(flow => flow.key === "coding/vibe")
}


/** Source-qualified completed child receipts; a green parent cannot supply one. */
export interface CodingVibeProgress {
  readonly stage: "admitted" | "cleaned" | "original-retained" | "cleaned-retained"
  readonly requestExecutionId: string
  readonly requestControlRunId?: string
  readonly spanId: string
  readonly summary?: string
  readonly sourceCommitId?: string
}
export const codingVibeProgressOf = (card: RunCard): CodingVibeProgress | undefined => {
  if (card.payload.workflow !== "coding/vibe") return undefined
  const input = vibeInput(card.payload.input)
  if (Option.isNone(input)) return undefined
  const evidence = engineRunEvidence(card.payload.events ?? [], card.payload.runId, card.payload.cursorSeq)
  const validated = evidence.completed.flatMap(execution => {
    const clean = execution.flowName === "coding/CleanVibeHistory" ? vibeCleanup(execution.result!.value) : Option.none()
    const admitted = execution.flowName === "coding/AdmitVibe" ? vibeAdmission(execution.result!.value)
      : Option.isSome(clean) ? Option.some(clean.value.admission) : Option.none()
    if (Option.isNone(admitted) || admitted.value.requestExecutionId !== input.value.requestExecutionId ||
      admitted.value.controlRunId === card.payload.runId || admitted.value.request.outcome.status !== "validated" ||
      admitted.value.request.outcome.blocked !== null || admitted.value.request.outcome.result?.status !== "validated" ||
      admitted.value.request.outcome.result.findings.length !== 0 ||
      Option.isSome(clean) && (clean.value.result.status !== "validated" || clean.value.result.findings.length !== 0) ||
      !nativeOwner(execution, evidence.executions, card.payload.runId, "coding/vibe", input.value, vibeInput, false)) return []
    return [{ execution, admission: admitted.value, cleanup: Option.getOrUndefined(clean) }]
  })
  const receipts: Array<CodingVibeProgress & { readonly sequence: number }> = validated.map(({ execution, admission, cleanup }) => ({
    stage: cleanup === undefined ? "admitted" : "cleaned", requestExecutionId: admission.requestExecutionId,
    requestControlRunId: admission.controlRunId, spanId: execution.spanId, sequence: execution.result!.sequence,
    ...(cleanup === undefined ? {} : { summary: cleanup.summary })
  }))
  const sameSource = (left: typeof SourcePublication.Type["source"], right: typeof PublicationInput.Type["source"]) =>
    left.changeId === right.changeId && left.commitId === right.commitId && left.treeId === right.treeId &&
    Digest.canonical(left.parentCommitIds) === Digest.canonical(right.parentCommitIds)
  for (const execution of evidence.completed) {
    if (execution.flowName !== "coding/PublishVibeSource" ||
      !nativeOwner(execution, evidence.executions, card.payload.runId, "coding/vibe", input.value, vibeInput, false)) continue
    const payload = publicationInput(execution.input), receipt = sourcePublication(execution.result!.value)
    if (Option.isNone(payload) || Option.isNone(receipt) || !sameSource(receipt.value.source, payload.value.source) ||
      card.payload.workspaceId !== undefined && card.payload.workspaceId !== receipt.value.workspaceId ||
      receipt.value.ref !== `refs/smithers/workspaces/${receipt.value.workspaceId}/sources/${receipt.value.source.commitId}`) continue
    const original = payload.value.phase === "original"
    const matches = validated.filter(value => original || value.cleanup !== undefined)
    if (matches.some(value => !sameSource(receipt.value.source, original ? value.admission.originalSource : value.cleanup!.head))) continue
    if (original) {
      // Retention precedes admission's final source check. Its actual owning
      // AdmitVibe input can prove the request before admission completes.
      const owner = evidence.executions.find(value => value.executionId === execution.parentExecutionId)
      const request = vibeInput(owner?.input)
      if (owner?.flowName !== "coding/AdmitVibe" || Option.isNone(request) ||
        Digest.canonical(request.value) !== Digest.canonical(input.value)) continue
    } else if (matches.length !== 1) continue
    receipts.push({ stage: original ? "original-retained" : "cleaned-retained", requestExecutionId: input.value.requestExecutionId,
      ...(matches[0] === undefined ? {} : { requestControlRunId: matches[0].admission.controlRunId }),
      spanId: execution.spanId, sequence: execution.result!.sequence, sourceCommitId: receipt.value.source.commitId })
  }
  receipts.sort((left, right) => right.sequence - left.sequence)
  const latest = receipts[0]
  return latest === undefined || receipts[1]?.sequence === latest.sequence ? undefined : latest
}
