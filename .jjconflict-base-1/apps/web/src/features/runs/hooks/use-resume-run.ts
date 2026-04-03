import type { ResumeRunInput } from "@burns/shared"

import { useMutation, useQueryClient } from "@tanstack/react-query"

import { burnsClient } from "@/lib/api/client"

export function useResumeRun(workspaceId?: string, runId?: string) {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: (input: ResumeRunInput = {}) => burnsClient.resumeRun(workspaceId!, runId!, input),
    onSuccess: async (run) => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["runs", workspaceId] }),
        queryClient.invalidateQueries({ queryKey: ["run", workspaceId, run.id] }),
      ])
    },
  })
}
