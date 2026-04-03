import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"

import { burnsClient } from "@/lib/api/client"

export function useWorkspaceServerStatus(workspaceId?: string) {
  return useQuery({
    queryKey: ["workspace-server-status", workspaceId],
    queryFn: () => burnsClient.getWorkspaceServerStatus(workspaceId!),
    enabled: Boolean(workspaceId),
    refetchInterval: 5_000,
  })
}

export function useWorkspaceServerActions(workspaceId?: string) {
  const queryClient = useQueryClient()

  async function invalidateServerQueries() {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ["workspace-server-status", workspaceId] }),
      queryClient.invalidateQueries({ queryKey: ["workspaces"] }),
    ])
  }

  const start = useMutation({
    mutationFn: () => burnsClient.startWorkspaceServer(workspaceId!),
    onSuccess: invalidateServerQueries,
  })

  const restart = useMutation({
    mutationFn: () => burnsClient.restartWorkspaceServer(workspaceId!),
    onSuccess: invalidateServerQueries,
  })

  const stop = useMutation({
    mutationFn: () => burnsClient.stopWorkspaceServer(workspaceId!),
    onSuccess: invalidateServerQueries,
  })

  return {
    start,
    restart,
    stop,
  }
}
