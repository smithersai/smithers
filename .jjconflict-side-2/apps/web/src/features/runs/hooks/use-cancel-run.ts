import type { CancelRunInput } from "@burns/shared"

import { useMutation, useQueryClient } from "@tanstack/react-query"

import { burnsClient } from "@/lib/api/client"

export function useCancelRun(workspaceId?: string, runId?: string) {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: (input: CancelRunInput = {}) => burnsClient.cancelRun(workspaceId!, runId!, input),
    onSuccess: async (run) => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["runs", workspaceId] }),
        queryClient.invalidateQueries({ queryKey: ["run", workspaceId, run.id] }),
      ])
    },
  })
}
