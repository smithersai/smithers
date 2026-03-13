import { useMutation } from "@tanstack/react-query"

import { burnsClient } from "@/lib/api/client"

export function useCopyWorkflowCdCommand(workspaceId?: string, workflowId?: string) {
  return useMutation({
    mutationFn: async () => {
      if (!workspaceId || !workflowId) {
        throw new Error("workspaceId and workflowId are required")
      }

      const command = await burnsClient.getWorkflowCdCommand(workspaceId, workflowId)

      if (typeof navigator?.clipboard?.writeText !== "function") {
        throw new Error("Clipboard API is unavailable in this browser.")
      }

      await navigator.clipboard.writeText(command)
    },
  })
}
