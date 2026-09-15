import type { ApprovalRow } from "@smthrs/gateway/GatewayProjection"
import type { AppStore } from "../AppStore"
import type { RunScope } from "../RunReference"
import { observedRuntimeApproval, runtimeApprovalKey, type RuntimeApproval } from "../RuntimeProjection"

/** Observe another client's decision without acquiring a human submission door. */
export const reconcileRunApprovals = async (store: AppStore, scope: RunScope, rows: ReadonlyArray<ApprovalRow>): Promise<void> => {
  const observed = new Map<string, RuntimeApproval>()
  const changed: ApprovalRow[] = []
  const at = Date.now()
  // Validate every response row, including duplicate gates within this batch,
  // before omitting idle reads. A conflicting later row refuses the whole batch.
  for (const row of rows) {
    const id = runtimeApprovalKey(scope, row.requestId, row.payload.target._tag === "Node" ? row.payload.target.digest : "")
    const previous = observed.get(id) ?? store.committedRuntimeApproval(id)
    const next = observedRuntimeApproval(previous, scope, row, at, (previous?.revision ?? 0) + 1)
    observed.set(id, next)
    if (next !== previous) changed.push(row)
  }
  if (changed.length > 0) await store.dispatch({ type: "gateway.approvals.observed", actor: "system", scope, rows: changed }).isPersisted.promise
}
