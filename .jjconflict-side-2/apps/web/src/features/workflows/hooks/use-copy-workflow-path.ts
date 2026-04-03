import { useMutation } from "@tanstack/react-query"

import { burnsClient } from "@/lib/api/client"
import { copyToClipboard } from "@/lib/copy-to-clipboard"

export function useCopyWorkflowPath(workspaceId?: string, workflowId?: string) {
  return useMutation({
    mutationFn: async () => {
      if (!workspaceId || !workflowId) {
        throw new Error("workspaceId and workflowId are required")
      }

      const workflowPath = await burnsClient.getWorkflowPath(workspaceId, workflowId)
      await copyToClipboard(workflowPath)
    },
  })
}
