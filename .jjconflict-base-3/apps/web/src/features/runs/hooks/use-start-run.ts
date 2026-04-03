import type { StartRunInput } from "@burns/shared"

import { useMutation, useQueryClient } from "@tanstack/react-query"

import { burnsClient } from "@/lib/api/client"

export function useStartRun(workspaceId?: string) {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: (input: StartRunInput) => burnsClient.startRun(workspaceId!, input),
    onSuccess: async (run) => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["runs", workspaceId] }),
        queryClient.invalidateQueries({ queryKey: ["run", workspaceId, run.id] }),
      ])
    },
  })
}
