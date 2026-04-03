import { Navigate, Outlet } from "react-router-dom"

import { useActiveWorkspace } from "@/features/workspaces/hooks/use-active-workspace"

export function WorkspaceLayout() {
  const { workspace, workspaces, isLoading } = useActiveWorkspace()

  if (isLoading) {
    return <div className="p-6 text-sm text-muted-foreground">Loading workspace…</div>
  }

  if (!workspace && workspaces[0]) {
    return <Navigate to={`/w/${workspaces[0].id}/overview`} replace />
  }

  return <Outlet />
}
