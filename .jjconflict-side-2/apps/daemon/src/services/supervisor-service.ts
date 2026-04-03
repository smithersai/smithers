import { existsSync } from "node:fs"

import { getWorkspace } from "@/services/workspace-service"

export function getWorkspaceHealth(workspaceId: string) {
  const workspace = getWorkspace(workspaceId)
  const status = workspace ? (existsSync(workspace.path) ? "healthy" : "disconnected") : "unknown"

  return {
    workspaceId,
    status,
    heartbeatAt: new Date().toISOString(),
  }
}
