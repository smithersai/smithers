import type { ApprovalRow } from "@smthrs/gateway/GatewayProjection"
import { sameApproval } from "../ApprovalReference"
import type { AppStore } from "../AppStore"
import { runScopeFromCard, sameRunScope, type RunScope } from "../RunReference"

/** Observe another client's decision without acquiring a human submission door. */
export const reconcileRunApprovals = (store: AppStore, scope: RunScope, rows: ReadonlyArray<ApprovalRow>): void => {
  const decided = rows.filter((row) => row.runId === scope.runId && row.status !== "pending" &&
    row.payload.target._tag === "Node" && sameApproval(row.payload.target, row))
  if (decided.length === 0) return
  for (const displayed of store.collections.cards.values()) {
    const trusted = store.approvalRequest(displayed.id)
    if (trusted === undefined) continue
    const recorded = runScopeFromCard(store, trusted, scope.runId)
    if (recorded === undefined || !sameRunScope(recorded, scope)) continue
    if (trusted.kind === "approval" && displayed.kind === "approval") {
      const row = decided.find((row) => row.requestId === trusted.payload.requestId && row.runId === trusted.payload.runId)
      const target = trusted.payload.approval?.target as { digest?: unknown } | undefined
      if (row === undefined || target?.digest !== row.payload.target.digest || row.status === "pending" ||
        (displayed.status === "acted" && displayed.payload.decision === row.status)) continue
      store.dispatch({ type: "card.approval.observed", actor: "system", id: displayed.id,
        runId: row.runId, requestId: row.requestId, digest: row.payload.target.digest, decision: row.status })
    } else if (trusted.kind === "approvals-inbox" && displayed.kind === "approvals-inbox") {
      let changed = false
      const approvals = displayed.payload.approvals.map((entry) => {
        const row = decided.find((row) => sameApproval(row, entry))
        const request = trusted.payload.approvals.find((candidate) => sameApproval(candidate, entry))
        const target = request?.approval.target as { digest?: unknown } | undefined
        if (row === undefined || row.status === "pending" || target?.digest !== row.payload.target.digest ||
          (entry.decision === row.status && entry.pending !== true && entry.decisionError === undefined)) return entry
        changed = true
        return { ...entry, decision: row.status, decidedAt: undefined, pending: undefined, decisionError: undefined }
      })
      if (changed) store.dispatch({ type: "card.updated", actor: "system", id: displayed.id,
        patch: { payload: { ...displayed.payload, approvals },
          status: approvals.every((row) => row.decision !== undefined) ? "acted" : "active" } })
    }
  }
}
