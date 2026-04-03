import { existsSync } from "node:fs"

import { getLogger } from "@/logging/logger"
import { deleteWorkspace, listWorkspaces } from "@/services/workspace-service"

const logger = getLogger().child({ component: "workspace.reconciliation.service" })

const DEFAULT_MISSING_WORKSPACE_MONITOR_INTERVAL_MS = 5_000

export type MissingWorkspacePruneSummary = {
  checkedWorkspaces: number
  removedWorkspaces: number
  failedWorkspaces: number
}

export async function pruneMissingWorkspaces(): Promise<MissingWorkspacePruneSummary> {
  const workspaces = listWorkspaces()
  const missingWorkspaces = workspaces.filter((workspace) => !existsSync(workspace.path))

  if (missingWorkspaces.length === 0) {
    return {
      checkedWorkspaces: workspaces.length,
      removedWorkspaces: 0,
      failedWorkspaces: 0,
    }
  }

  let removedWorkspaces = 0
  let failedWorkspaces = 0

  for (const workspace of missingWorkspaces) {
    try {
      logger.warn(
        {
          event: "workspace.reconciliation.missing_workspace_removed",
          workspaceId: workspace.id,
          workspacePath: workspace.path,
        },
        "Removing missing workspace from Burns registry"
      )

      await deleteWorkspace(workspace.id, { mode: "unlink" })
      removedWorkspaces += 1
    } catch (error) {
      failedWorkspaces += 1
      logger.error(
        {
          event: "workspace.reconciliation.remove_missing_workspace_failed",
          workspaceId: workspace.id,
          workspacePath: workspace.path,
          err: error,
        },
        "Failed removing missing workspace from Burns registry"
      )
    }
  }

  return {
    checkedWorkspaces: workspaces.length,
    removedWorkspaces,
    failedWorkspaces,
  }
}

export function startMissingWorkspaceMonitor(intervalMs = DEFAULT_MISSING_WORKSPACE_MONITOR_INTERVAL_MS) {
  const runPrune = () => {
    void pruneMissingWorkspaces().catch((error) => {
      logger.error(
        {
          event: "workspace.reconciliation.monitor_tick_failed",
          err: error,
        },
        "Missing workspace monitor tick failed"
      )
    })
  }

  runPrune()
  const timer = setInterval(runPrune, intervalMs)
  timer.unref()

  return () => {
    clearInterval(timer)
  }
}
