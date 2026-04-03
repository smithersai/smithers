import { useMutation } from "@tanstack/react-query"

import { burnsClient } from "@/lib/api/client"
import { copyToClipboard } from "@/lib/copy-to-clipboard"

export function useCopyWorkspacePath(workspaceId?: string) {
  return useMutation({
    mutationFn: async () => {
      if (!workspaceId) {
        throw new Error("workspaceId is required")
      }

      const workspacePath = await burnsClient.getWorkspacePath(workspaceId)
      await copyToClipboard(workspacePath)
    },
  })
}
