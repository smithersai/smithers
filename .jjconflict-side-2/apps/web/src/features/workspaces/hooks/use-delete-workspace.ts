import type { DeleteWorkspaceInput, DeleteWorkspaceResult } from "@burns/shared"

import { useMutation, useQueryClient } from "@tanstack/react-query"

import { burnsClient } from "@/lib/api/client"

type DeleteWorkspaceParams = {
  workspaceId: string
  input: DeleteWorkspaceInput
}

export function useDeleteWorkspace() {
  const queryClient = useQueryClient()

  return useMutation<DeleteWorkspaceResult, Error, DeleteWorkspaceParams>({
    mutationFn: ({ workspaceId, input }) => burnsClient.deleteWorkspace(workspaceId, input),
    onSuccess: async (_result, variables) => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["workspaces"] }),
        queryClient.invalidateQueries({ queryKey: ["workflows", variables.workspaceId] }),
        queryClient.invalidateQueries({ queryKey: ["runs", variables.workspaceId] }),
        queryClient.invalidateQueries({ queryKey: ["approvals", variables.workspaceId] }),
        queryClient.invalidateQueries({ queryKey: ["workspace-server-status", variables.workspaceId] }),
      ])
    },
  })
}
