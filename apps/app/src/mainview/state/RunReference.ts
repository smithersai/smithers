import type { Card } from "./AppState"
import type { AppStore } from "./AppStore"
import { traceFromJournal } from "../cards/RunTrace"

/** A UI address, not a new backend run ID. Missing workspace means the legacy gateway. */
export interface RunScope {
  readonly repo: string
  readonly runId: string
  readonly workspaceId?: string
}

export const sameRunScope = (left: RunScope, right: RunScope): boolean =>
  left.repo === right.repo && left.runId === right.runId && left.workspaceId === right.workspaceId

/** Only persisted rows (or an actually recorded control child) establish membership. */
export const cardContainsRun = (card: Card, runId: string, allowChild = false): boolean => {
  switch (card.kind) {
    case "run-trace": return card.payload.runId === runId || (allowChild && traceFromJournal({
      runId: card.payload.runId, flowId: card.payload.workflow, status: card.payload.phase
    }, card.payload.events ?? []).rows.some((row) => row.detail.childRunId === runId))
    case "approval": return card.payload.runId === runId
    case "run-list": return card.payload.runs.some((row) => row.runId === runId)
    case "approvals-inbox": return card.payload.approvals.some((row) => row.runId === runId)
    default: return false
  }
}

/** Old ancillary omission can inherit only the already-recorded legacy-key run trace. */
export const runScopeFromCard = (store: AppStore, card: Card, runId: string): RunScope | undefined => {
  if (!("repo" in card.payload) || typeof card.payload.repo !== "string") return undefined
  let workspaceId = "workspaceId" in card.payload && typeof card.payload.workspaceId === "string"
    ? card.payload.workspaceId : undefined
  if (workspaceId === undefined && card.kind !== "run-trace" && !("gatewayBindingVersion" in card.payload && card.payload.gatewayBindingVersion === 1)) {
    const trace = store.collections.cards.get(`flow-run-${runId}`)
    if (trace?.kind === "run-trace" && trace.payload.runId === runId && trace.payload.repo === card.payload.repo) {
      workspaceId = trace.payload.workspaceId
    }
  }
  return { repo: card.payload.repo, runId, ...(workspaceId === undefined ? {} : { workspaceId }) }
}

export const runCardInScope = (store: AppStore, scope: RunScope): Extract<Card, { kind: "run-trace" }> | undefined =>
  [...store.collections.cards.values()].flatMap((card) =>
    card.kind === "run-trace" && sameRunScope(card.payload, scope) ? [card] : [])
    .sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0)[0]

/** Preserve old addresses used by frames/messages; qualify newly created bound identities. */
export const runCardIdFor = (store: AppStore, scope: RunScope): string => {
  const existing = runCardInScope(store, scope)
  if (existing !== undefined) return existing.id
  const legacy = `flow-run-${scope.runId}`
  if (scope.workspaceId === undefined && !store.collections.cards.has(legacy)) return legacy
  return `flow-run@${scopeKey(scope)}`
}
const scopeKey = (scope: RunScope): string =>
  [scope.repo, scope.workspaceId ?? "legacy", scope.runId].map(encodeURIComponent).join("@")

export const approvalCardIdFor = (store: AppStore, scope: RunScope, requestId: string): string => {
  const existing = [...store.collections.cards.values()].filter((card) => {
    if (card.kind !== "approval" || card.payload.requestId !== requestId || card.payload.runId !== scope.runId) return false
    const recorded = runScopeFromCard(store, card, scope.runId)
    return recorded !== undefined && sameRunScope(recorded, scope)
  }).sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0)[0]
  if (existing !== undefined) return existing.id
  const legacy = `approval-${scope.runId}-${requestId}`
  if (scope.workspaceId === undefined && !store.collections.cards.has(legacy)) return legacy
  return `approval@${scopeKey(scope)}@${encodeURIComponent(requestId)}`
}
