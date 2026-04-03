import type { Approval, ApprovalStatus, Workspace } from "@burns/shared"

import type { ConfirmationState } from "@/components/ai-elements/confirmation"

export type ApprovalFilter = "all" | ApprovalStatus
export type ApprovalSort = "wait-desc" | "wait-asc" | "updated-desc" | "updated-asc"

export type InboxApprovalItem = Approval & {
  workspaceName: string
  runHref: string
}

export function getApprovalConfirmationState(status: ApprovalStatus): ConfirmationState {
  if (status === "approved") {
    return "output-available"
  }

  if (status === "denied") {
    return "output-denied"
  }

  return "approval-requested"
}

function toUpdatedTimestamp(approval: Approval) {
  if (!approval.decidedAt) {
    return 0
  }

  const parsed = Date.parse(approval.decidedAt)
  return Number.isFinite(parsed) ? parsed : 0
}

export function sortApprovals(approvals: Approval[], sort: ApprovalSort) {
  const sorted = [...approvals]

  sorted.sort((left, right) => {
    if (sort === "wait-desc") {
      return right.waitMinutes - left.waitMinutes
    }

    if (sort === "wait-asc") {
      return left.waitMinutes - right.waitMinutes
    }

    if (sort === "updated-asc") {
      return toUpdatedTimestamp(left) - toUpdatedTimestamp(right)
    }

    return toUpdatedTimestamp(right) - toUpdatedTimestamp(left)
  })

  return sorted
}

export function buildPendingApprovalInboxItems(
  workspaces: Workspace[],
  approvalsByWorkspaceId: Record<string, Approval[]>
) {
  return workspaces
    .flatMap((workspace) =>
      (approvalsByWorkspaceId[workspace.id] ?? [])
        .filter((approval) => approval.status === "pending")
        .map<InboxApprovalItem>((approval) => ({
          ...approval,
          workspaceName: workspace.name,
          runHref: `/w/${workspace.id}/runs/${approval.runId}`,
        }))
    )
    .sort((left, right) => right.waitMinutes - left.waitMinutes)
}

export function getRunApprovals(approvals: Approval[], runId?: string | null) {
  if (!runId) {
    return []
  }

  return approvals.filter((approval) => approval.runId === runId)
}

export function getNodeApproval(
  approvals: Approval[],
  params: {
    nodeId?: string | null
    runId?: string | null
  }
) {
  if (!params.nodeId || !params.runId) {
    return undefined
  }

  return approvals.find((approval) => approval.runId === params.runId && approval.nodeId === params.nodeId)
}
