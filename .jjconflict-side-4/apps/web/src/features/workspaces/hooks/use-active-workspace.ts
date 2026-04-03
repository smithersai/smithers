import { useEffect, useMemo } from "react"
import { useParams } from "react-router-dom"

import {
  setActiveWorkspaceId,
  useStoredActiveWorkspaceId,
} from "@/features/workspaces/lib/active-workspace-store"
import { useWorkspaces } from "@/features/workspaces/hooks/use-workspaces"

export function useActiveWorkspace() {
  const { workspaceId: routeWorkspaceId } = useParams()
  const storedWorkspaceId = useStoredActiveWorkspaceId()
  const { data: workspaces = [], ...query } = useWorkspaces()

  const fallbackWorkspaceId = workspaces[0]?.id
  const workspaceId = routeWorkspaceId ?? storedWorkspaceId ?? fallbackWorkspaceId

  const workspace = useMemo(
    () => workspaces.find((entry) => entry.id === workspaceId) ?? null,
    [workspaceId, workspaces]
  )

  useEffect(() => {
    if (routeWorkspaceId && routeWorkspaceId !== storedWorkspaceId) {
      setActiveWorkspaceId(routeWorkspaceId)
    }
  }, [routeWorkspaceId, storedWorkspaceId])

  useEffect(() => {
    if (!routeWorkspaceId && !storedWorkspaceId && fallbackWorkspaceId) {
      setActiveWorkspaceId(fallbackWorkspaceId)
    }
  }, [fallbackWorkspaceId, routeWorkspaceId, storedWorkspaceId])

  useEffect(() => {
    if (!workspace && fallbackWorkspaceId && workspaceId !== fallbackWorkspaceId) {
      setActiveWorkspaceId(fallbackWorkspaceId)
    }
  }, [fallbackWorkspaceId, workspace, workspaceId])

  return {
    ...query,
    workspaces,
    workspaceId,
    workspace,
    setWorkspaceId: setActiveWorkspaceId,
  }
}
