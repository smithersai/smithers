import type { Workspace } from "@burns/shared"

export function canEditWorkspaceWorkflows(
  workspace: Pick<Workspace, "runtimeMode"> | null | undefined
) {
  return workspace?.runtimeMode !== "self-managed"
}
