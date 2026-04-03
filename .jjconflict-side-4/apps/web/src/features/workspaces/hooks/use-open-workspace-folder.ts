import { useMutation } from "@tanstack/react-query"

import { burnsClient } from "@/lib/api/client"

export function useOpenWorkspaceFolder(workspaceId?: string) {
  return useMutation({
    mutationFn: async () => {
      if (!workspaceId) {
        throw new Error("workspaceId is required")
      }

      await burnsClient.openWorkspaceFolder(workspaceId)
    },
  })
}
