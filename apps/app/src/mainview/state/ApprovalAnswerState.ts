import { canonicalEventValue } from "./EventValue"
import type { AppStore } from "./AppStore"
import type { RuntimeApproval } from "./RuntimeProjection"
import { runtimeApprovalIdOf, runtimeApprovalKey, runtimeScopeOf } from "./RuntimeProjection"
import { parseApprovalActionId } from "./ApprovalReference"
import { approvalQuestionKey, questionOf } from "../cards/ApprovalQuestion"
export { approvalQuestionKey } from "../cards/ApprovalQuestion"

export interface ApprovalAnswerInput { readonly id: string; readonly question: string; readonly text: string }

/** Only the separately retained request authority can name a human wait. */
export const resolveApprovalAnswer = (store: AppStore, actionId: string): RuntimeApproval | undefined => {
  const reference = parseApprovalActionId(actionId)
  const card = store.approvalRequest(reference?.cardId ?? actionId)
  if (card === undefined || card.runtimeView?.revision !== undefined) return undefined
  if (reference === undefined) {
    const id = runtimeApprovalIdOf(card)
    return id === undefined ? undefined : store.collections.runtimeApprovals.get(id)
  }
  if (card.kind !== "approvals-inbox") return undefined
  const rows = card.payload.approvals.filter(row => row.runId === reference.runId && row.requestId === reference.requestId)
  const row = rows.length === 1 ? rows[0] : undefined
  const scope = runtimeScopeOf(card, reference.runId)
  const target = row?.approval.target as { digest?: unknown } | undefined
  if (scope === undefined || typeof target?.digest !== "string") return undefined
  return store.collections.runtimeApprovals.get(runtimeApprovalKey(scope, reference.requestId, target.digest))
}

export const decideApprovalAnswerInput = (
  store: AppStore, actionId: string, field: string, value: string
): ApprovalAnswerInput | { readonly error: string } => {
  const approval = resolveApprovalAnswer(store, actionId)
  const question = approval === undefined ? undefined : approvalQuestionKey(approval.row)
  if (approval === undefined || question === undefined || field !== `answer:${question}` || approval.row.status !== "pending" || approval.pending) {
    return { error: "This question is no longer waiting for that answer." }
  }
  return { id: approval.id, question, text: value }
}

export const isCurrentApprovalAnswer = (row: RuntimeApproval | undefined, input: ApprovalAnswerInput): boolean =>
  row !== undefined && row.id === input.id && row.row.status === "pending" && row.pending !== true
    && typeof input.text === "string" && typeof input.question === "string" && approvalQuestionKey(row.row) === input.question

/** A human submission is validated against the currently observed question before a receipt or POST. */
export const prepareApprovalAnswer = (
  store: AppStore, actionId: string, value: unknown, expectedQuestion?: string
): ApprovalAnswerInput | undefined => {
  const row = resolveApprovalAnswer(store, actionId)
  if (row === undefined) return undefined
  const key = approvalQuestionKey(row.row), question = questionOf(row.row)
  if (key === undefined || question === undefined || expectedQuestion !== undefined && expectedQuestion !== key) return undefined
  let text: string
  switch (question.kind) {
    case "ask":
      if (typeof value !== "string" || value.trim() === "") return undefined
      text = value.trim()
      break
    case "confirm":
      if (typeof value !== "boolean") return undefined
      text = JSON.stringify(value)
      break
    case "select":
      if (typeof value !== "string" || !question.options?.includes(value)) return undefined
      text = value
      break
    case "json":
      try {
        if (value === undefined) return undefined
        // Verify the input without invoking arbitrary toJSON/getters.
        canonicalEventValue(value)
        text = JSON.stringify(value)
      } catch { return undefined }
  }
  const input = { id: row.id, question: key, text }
  return isCurrentApprovalAnswer(row, input) ? input : undefined
}
