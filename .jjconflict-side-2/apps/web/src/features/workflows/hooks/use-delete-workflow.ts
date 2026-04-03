import { useMutation, useQueryClient } from "@tanstack/react-query"

import { burnsClient } from "@/lib/api/client"

export function useDeleteWorkflow(workspaceId?: string) {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: async (workflowId: string) => burnsClient.deleteWorkflow(workspaceId!, workflowId),
    onSuccess: async (_, workflowId) => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["workflows", workspaceId] }),
        queryClient.removeQueries({ queryKey: ["workflow", workspaceId, workflowId] }),
      ])
    },
  })
}
