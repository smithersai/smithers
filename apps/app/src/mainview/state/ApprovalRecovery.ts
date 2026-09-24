import type { Card } from "./AppState"
import type { AppStore } from "./AppStore"

/** Release decisions whose forwarder ended without a receipt, preserving the reviewed request. */
export const releaseInterruptedApproval = async (store: Pick<AppStore, "dispatch">, card: Card | undefined, message: string, target?: { requestId: string; runId?: string }): Promise<void> => {
  const selected = (row: { pending?: boolean; requestId: string; runId: string }) => row.pending === true &&
    (target === undefined || row.requestId === target.requestId && (target.runId === undefined || row.runId === target.runId))
  if (card?.kind === "approval" && card.payload.pending === true && card.status !== "acted") {
    await store.dispatch({ type: "card.approval.decision.failed", actor: "system", id: card.id, message }).isPersisted.promise
  } else if (card?.kind === "approvals-inbox" && card.payload.approvals.some(selected)) {
    await store.dispatch({ type: "card.updated", actor: "system", id: card.id, patch: { payload: { ...card.payload,
      approvals: card.payload.approvals.map(row => selected(row) ? { ...row, pending: undefined, decisionError: message } : row)
    } } }).isPersisted.promise
  }
}
