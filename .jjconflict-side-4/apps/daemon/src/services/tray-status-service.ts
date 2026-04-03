import type { Approval, BurnsTrayStatus, Run, Workspace } from "@burns/shared"

import { listApprovals } from "@/services/approval-service"
import { listRuns } from "@/services/smithers-service"
import { listWorkspaces } from "@/services/workspace-service"

type TrayStatusDependencies = {
  listWorkspaces?: () => Workspace[]
  listRuns?: (workspaceId: string) => Promise<Run[]>
  listApprovals?: (workspaceId: string) => Approval[]
}

export async function getTrayStatus(
  dependencies: TrayStatusDependencies = {}
): Promise<BurnsTrayStatus> {
  const listWorkspacesFn = dependencies.listWorkspaces ?? listWorkspaces
  const listRunsFn = dependencies.listRuns ?? listRuns
  const listApprovalsFn = dependencies.listApprovals ?? listApprovals
  const workspaces = listWorkspacesFn()

  const pendingApprovals = workspaces.flatMap((workspace) =>
    listApprovalsFn(workspace.id).filter((approval) => approval.status === "pending")
  )

  const runResults = await Promise.all(
    workspaces.map(async (workspace) => {
      try {
        return await listRunsFn(workspace.id)
      } catch {
        return []
      }
    })
  )

  const runningCount = runResults
    .flat()
    .filter((run) => run.status === "running").length

  const pendingCount = pendingApprovals.length
  const pendingTarget =
    pendingCount === 1
      ? {
          kind: "run" as const,
          workspaceId: pendingApprovals[0]!.workspaceId,
          runId: pendingApprovals[0]!.runId,
        }
      : pendingCount > 1
        ? {
            kind: "inbox" as const,
          }
        : null

  return {
    pendingCount,
    runningCount,
    pendingTarget,
  }
}
