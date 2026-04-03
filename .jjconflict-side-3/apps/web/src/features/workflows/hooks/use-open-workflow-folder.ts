import { useMutation } from "@tanstack/react-query"

import { burnsClient } from "@/lib/api/client"

export function useOpenWorkflowFolder(workspaceId?: string, workflowId?: string) {
  return useMutation({
    mutationFn: async () => {
      if (!workspaceId || !workflowId) {
        throw new Error("workspaceId and workflowId are required")
      }

      await burnsClient.openWorkflowFolder(workspaceId, workflowId)
    },
  })
}
